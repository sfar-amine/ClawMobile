"""Bounded read-only projection of the installed memory-core event owner."""
import datetime
from pathlib import Path
import sqlite3
import time

MAX_EVENTS = 10000

def read_native_metrics(path, now):
    result = {"deepPromotions7d": None, "deepPromotionsWindowComplete": False,
              "memoryRecallCount": None, "nativeDeepRuns7d": None,
              "nativeDeepLines7d": None, "nativeMetricsAt": None,
              "nativeMetricsState": "owner_unavailable",
              "promotionSemantics": None}
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        return result
    try:
        with sqlite3.connect(path.resolve().as_uri()+"?mode=ro", uri=True, timeout=.02) as conn:
            conn.execute('PRAGMA query_only=ON')
            conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 128*1024)
            deadline = time.monotonic()+.25
            conn.set_progress_handler(lambda: int(time.monotonic()>deadline), 1000)
            # Never project query/results/reportPath or any other owner content.
            rows = conn.execute("""SELECT json_extract(value_json,'$.event.type'),
                 json_extract(value_json,'$.event.timestamp'),
                 json_extract(value_json,'$.event.phase'),
                 json_extract(value_json,'$.event.lineCount'),
                 json_extract(value_json,'$.event.applied'),
                 json_type(value_json,'$.event.applied')
                 FROM plugin_state_entries WHERE plugin_id='memory-core'
                 AND namespace='memory-host.events'
                 LIMIT ?""", (MAX_EVENTS+1,)).fetchall()
        if len(rows)>MAX_EVENTS:
            return dict(result,nativeMetricsState='owner_volume_unverified')
        start=now-datetime.timedelta(days=7)
        first=None; recalls=0; deep=0; lines=0; applied=0
        for kind,stamp,phase,count,promotions,promotion_type in rows:
            try:
                date=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
                if date.tzinfo is None or not isinstance(kind,str):
                    return dict(result,nativeMetricsState="owner_event_invalid")
            except (ValueError,TypeError,AttributeError):
                return dict(result,nativeMetricsState="owner_event_invalid")
            if date>now: continue
            if first is None or date<first: first=date
            if date<start: continue
            if kind=='memory.promotion.applied':
                if promotion_type!='integer' or type(promotions) is not int or not 0<=promotions<=1000000:
                    return dict(result,nativeMetricsState='owner_promotion_count_invalid')
                applied+=promotions
                if applied>1000000:
                    return dict(result,nativeMetricsState='owner_promotion_count_invalid')
            elif kind=='memory.recall.recorded': recalls+=1
            elif kind=='memory.dream.completed' and phase=='deep':
                deep+=1
                if type(count) is int and 0<=count<=1000000: lines+=count
        complete=first is not None and first<start
        if not complete:
            return dict(result,nativeMetricsState='owner_window_incomplete')
        # Installed owner event confirmed by Claude's full-window RO observation
        # on 2026-10-10 20:10 UTC (core PR80, comment 20:56). Applied includes
        # reconciliation of already-written candidates; never count report lines.
        return dict(result,deepPromotions7d=applied,deepPromotionsWindowComplete=True,
                    promotionSemantics='applied_including_reconciliations',
                    memoryRecallCount=recalls,nativeDeepRuns7d=deep,
                    nativeDeepLines7d=lines,nativeMetricsAt=now.isoformat(),
                    nativeMetricsState='observed')
    except (OSError,sqlite3.Error):
        return result
