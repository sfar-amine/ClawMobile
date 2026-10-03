#!/usr/bin/env python3
"""Synthetic whole-history benchmark; excludes transport and model reasoning."""
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import statistics
import tempfile
import time

from context_memory import build_view, search
spec = importlib.util.spec_from_file_location('store', Path(__file__).with_name('context-store.py'))
store = importlib.util.module_from_spec(spec); spec.loader.exec_module(store)


def old_search(c, query):
    # Previous ordinary retrieval: latest 5000, substring scoring in Python.
    rows = c.execute('SELECT id,surface,kind,text,created_at,supersedes FROM events ORDER BY created_at DESC LIMIT 5000').fetchall()
    superseded = {r[5] for r in rows if r[5]}
    return [r[0] for r in rows if r[0] not in superseded and query.lower() in r[3].lower()][:12]


def time_queries(call, queries):
    values = []
    for query in queries:
        start = time.perf_counter(); call(query); values.append((time.perf_counter() - start) * 1000)
    ordered = sorted(values)
    return {'p50_ms': round(statistics.median(values), 3), 'p95_ms': round(ordered[int(.95 * (len(ordered) - 1))], 3), 'n': len(values)}


def main():
    results = []
    for days in (30, 90, 180):
        with tempfile.TemporaryDirectory(prefix='memory-scale-bench-') as tmp:
            c = sqlite3.connect(Path(tmp) / 'memory.db', isolation_level=None)
            # Index construction is measured separately from warm query cost.
            c.execute('CREATE TABLE events(id TEXT PRIMARY KEY,surface TEXT,kind TEXT,text TEXT,created_at TEXT,ingested_at TEXT,supersedes TEXT,revision INTEGER)')
            rows = []; old_ids = []
            for revision in range(1, days * 100 + 1):
                if revision <= 12:
                    kind = 'constraint'; text = f'ORACLE{revision:04d} Ne jamais envoyer sans preuve explicite {revision}.'
                elif revision <= 42:
                    kind = 'open_thread'; text = f'ORACLE{revision:04d} Projet {revision} : attendre la décision documentée.'
                else:
                    kind = ['learning', 'decision', 'completed_action', 'checkpoint'][revision % 4]
                    text = f'Activité synthétique {revision} sans rapport avec la demande. ' * 5
                eid = hashlib.sha256(str(revision).encode()).hexdigest()
                if revision <= 42: old_ids.append(eid)
                stamp = (dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=revision * 14)).isoformat()
                rows.append((eid, ['chat', 'work', 'voice', 'openclaw'][revision % 4], kind, text, stamp, stamp, None, revision))
            c.execute('BEGIN'); c.executemany('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', rows); c.execute('COMMIT')
            start = time.perf_counter(); store.migrate(c); index_ms = (time.perf_counter() - start) * 1000
            queries = [f'ORACLE{i:04d}' for i in range(1, 43)]
            before_hits = sum(bool(old_search(c, q)) for q in queries)
            after_hits = sum(bool(search(c, q)) for q in queries)
            old_active = c.execute("SELECT id,kind,text FROM events ORDER BY created_at DESC LIMIT 500").fetchall()
            caps = {'constraint': 12, 'open_thread': 12, 'decision': 18, 'learning': 16, 'completed_action': 12, 'checkpoint': 6}
            selected = []; counts = {}
            for eid, kind, text in old_active:
                if counts.get(kind, 0) < caps[kind]: selected.append((eid, kind, text)); counts[kind] = counts.get(kind, 0) + 1
            body, meta = build_view(c, len(rows))
            results.append({'days': days, 'assumed_events_per_day': 100, 'events': len(rows),
                'index_build_ms': round(index_ms, 3),
                'ordinary_old_fact_hits': {'before': before_hits, 'after': after_hits, 'expected': 42},
                'active_essential_view_coverage': {'before': sum(r[0] in old_ids for r in selected), 'after': meta['active_counts']['constraint'] + meta['active_counts']['open_thread'], 'expected': 42},
                'view_bytes': {'before_body': len('\n'.join(x[2] for x in selected).encode()), 'after_body': len(body.encode())},
                'coverage_complete': meta['coverage_complete'],
                'ordinary_search': {'before': time_queries(lambda q: old_search(c, q), queries), 'after': time_queries(lambda q: search(c, q), queries)}})
            c.close()
    print(json.dumps({'version': 1, 'kind': 'synthetic_backend_only', 'limitations': ['100 events/day is a scenario, not a forecast', 'Exact oracle facts, not semantic paraphrase evaluation', 'No Slack/network/model/comprehension timing', 'view byte comparison excludes foundation and Markdown wrappers'], 'results': results}, indent=2))


if __name__ == '__main__': main()
