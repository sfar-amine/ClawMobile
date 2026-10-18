"""Indexes and bounded projections of the existing immutable semantic event store.

No model calls, event rewriting, scheduler or independent source of truth.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import unicodedata
from datetime import datetime, timedelta, timezone

KINDS = ('constraint', 'open_thread', 'decision', 'learning', 'completed_action', 'checkpoint')
COLUMNS = 'e.id,e.revision,e.surface,e.kind,e.text,e.created_at,e.supersedes'
ACTIVE = "NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes=e.id)"
VIEW_BUDGET_BYTES = 16384
# Wire contract owned by this producer; playbooks carry a CI-checked copy.
# Complete source indexes never mean that full constraint bodies were read.
COVERAGE_INDEX_COMPLETE = 'constraint_index_complete; open_thread_index_complete'
# Named reader transition for pre-b760d368 materialized views only.
COVERAGE_LEGACY_COMPLETE = 'constraints_complete; open_thread_index_complete'
RECENT_CAPS = {'decision': 12, 'learning': 8, 'completed_action': 5, 'checkpoint': 3}
# M1 has three explicit shares. They are maxima and scale down with a caller's
# smaller custom budget; unused bytes remain available to the other sections.
ACTIVITY_RESERVE_BYTES = 6144
OLDER_DECISION_RESERVE_BYTES = 2048
THREAD_RESERVE_BYTES = 4096
THREAD_EXCERPT_CHARS = 320
CONSTRAINT_EXCERPT_CHARS = 120
# M3 « une seule mémoire » : machine telemetry whose canonical owner is elsewhere.
# situation_events (skill_intelligence), learning-gate receipts/journal, ~/.openclaw/deploys/companion-*.json.
# No legitimate producer remains: new events are refused at ingress (context-event.sh, ingest_file).
# IMPROVEMENT_CANDIDATE_V1 is NOT refused: curator -> dream_proposals -> improvement bridge consumes it.
REFUSED_TELEMETRY = re.compile(r'^(?:SITUATION_EVENT_V1:|LEARNING_GATE_V\d+:|Companion déployé [0-9a-f]{12} \(précédent [0-9a-f]{12}\), recette automatique acceptée\.$)')
# Supersession receipt of context-retire-telemetry.py: bookkeeping, never knowledge.
RETIRE_PREFIX = 'MEMORY_RETIRE_V1 '
NOT_RETIRE_RECEIPT = "substr(e.text,1,17)<>'MEMORY_RETIRE_V1 '"
# Machine telemetry is searchable history, never "recent activity" in the shared view.
TELEMETRY = re.compile(r'^(?:SITUATION_EVENT_V1|LEARNING_GATE_V\d*|IMPROVEMENT_CANDIDATE|Companion déployé|MEMORY_RETIRE_V1 )')


def refused_telemetry(text):
    return bool(REFUSED_TELEMETRY.match(' '.join(str(text or '').split())))


def ensure_indexes(connection):
    """Called inside the existing writer transaction; migration is idempotent."""
    connection.execute('CREATE INDEX IF NOT EXISTS idx_events_supersedes ON events(supersedes)')
    connection.execute('CREATE INDEX IF NOT EXISTS idx_events_kind_revision ON events(kind,revision)')
    marker = connection.execute("SELECT value FROM memory_meta WHERE key='search_index_version'").fetchone()
    if marker and marker[0] == '1':
        return
    connection.execute("CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text,content='events',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2')")
    connection.execute("CREATE TRIGGER IF NOT EXISTS events_search_insert AFTER INSERT ON events BEGIN INSERT INTO events_fts(rowid,text) VALUES(new.rowid,new.text); END")
    connection.execute("CREATE TRIGGER IF NOT EXISTS events_search_delete AFTER DELETE ON events BEGIN INSERT INTO events_fts(events_fts,rowid,text) VALUES('delete',old.rowid,old.text); END")
    connection.execute("CREATE TRIGGER IF NOT EXISTS events_search_update AFTER UPDATE OF text ON events BEGIN INSERT INTO events_fts(events_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO events_fts(rowid,text) VALUES(new.rowid,new.text); END")
    connection.execute("INSERT INTO events_fts(events_fts) VALUES('rebuild')")
    connection.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('search_index_version','1')")


def day(item):
    """Doc 49 M3: every fact in the shared view carries its date (Tunis), so Samantha can tell old from new."""
    raw = item.get('createdAt') or ''
    try:
        import datetime
        stamp = datetime.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        try:
            from zoneinfo import ZoneInfo
            stamp = stamp.astimezone(ZoneInfo('Africa/Tunis'))
        except Exception:
            pass
        return stamp.strftime('%d/%m')
    except Exception:
        return '--/--'


def event_datetime(item):
    """Return an aware timestamp when the store value is usable."""
    try:
        stamp = datetime.fromisoformat(str(item.get('createdAt') or '').replace('Z', '+00:00'))
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def event(row):
    return dict(zip(('id', 'revision', 'surface', 'kind', 'text', 'createdAt', 'supersedes'), row))


def by_reference(connection, query):
    refs = list(dict.fromkeys(re.findall(r'\b((?:AMINE-)?REQ-\d+|EVT-\d+)\b', query, re.I)))
    results = []
    for ref in refs[:20]:
        rev = int(ref.rsplit('-', 1)[1])
        row = connection.execute(f'SELECT {COLUMNS} FROM events e WHERE revision=?', (rev,)).fetchone()
        if row is None:
            results.append({'reference': ref.upper(), 'found': False, 'state': 'missing'})
            continue
        opening = event(row)
        chain = [opening]
        seen = {opening['id']}
        queue = [opening['id']]
        for parent in queue:
            for child in connection.execute(f'SELECT {COLUMNS} FROM events e WHERE supersedes=? ORDER BY revision', (parent,)):
                item = event(child)
                if item['id'] not in seen:
                    seen.add(item['id']); chain.append(item); queue.append(item['id'])
        chain.sort(key=lambda item: item['revision'])
        leaves = [item for item in chain if not connection.execute('SELECT 1 FROM events WHERE supersedes=? LIMIT 1', (item['id'],)).fetchone()]
        current = chain[-1]
        results.append({'reference': ref.upper(), 'found': True,
                        'state': 'conflict' if len(leaves) > 1 else ('resolved' if current['kind'] == 'completed_action' else 'open'),
                        'opening': opening, 'current': current, 'chain': chain,
                        'currentCandidates': leaves})
    return results


def search(connection, query, limit=12, *, history=False, kind=None, offset=0):
    """Read-only full-history search. No hidden recency window or DB creation."""
    limit = max(1, min(int(limit), 50)); offset = max(0, int(offset))
    if kind is not None and kind not in KINDS:
        raise ValueError('unknown_kind')
    refs = by_reference(connection, query)
    if refs:
        return refs
    filters, parameters = ([] if history else [ACTIVE, NOT_RETIRE_RECEIPT]), []
    if kind:
        filters.append('e.kind=?'); parameters.append(kind)
    terms = list(dict.fromkeys(re.findall(r'\w+', query, re.UNICODE)))[:24]
    where = ' AND '.join(filters) or '1'
    indexed = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events_fts'").fetchone()
    if terms and indexed:
        # Quoted tokens only: user text can never inject an FTS expression.
        match = ' OR '.join('"' + term.replace('"', '""') + '"' for term in terms)
        sql = f'SELECT {COLUMNS} FROM events_fts JOIN events e ON e.rowid=events_fts.rowid WHERE events_fts MATCH ? AND {where} ORDER BY bm25(events_fts),e.revision DESC LIMIT ? OFFSET ?'
        rows = connection.execute(sql, (match, *parameters, limit, offset)).fetchall()
    elif terms:
        # Read-only compatibility with pre-index snapshots; searches ALL events.
        clauses = ['lower(e.text) LIKE ? ESCAPE \'\\\'' for _ in terms]
        escaped = [t.lower().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') for t in terms]
        sql = f'SELECT {COLUMNS} FROM events e WHERE {where} AND (' + ' OR '.join(clauses) + ') ORDER BY e.revision DESC LIMIT ? OFFSET ?'
        rows = connection.execute(sql, (*parameters, *['%' + x + '%' for x in escaped], limit, offset)).fetchall()
    else:
        rows = connection.execute(f'SELECT {COLUMNS} FROM events e WHERE {where} ORDER BY e.revision DESC LIMIT ? OFFSET ?', (*parameters, limit, offset)).fetchall()
    return [event(row) for row in rows]


def normalized(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def excerpt(text, max_chars):
    text = ' '.join(text.split())
    if len(text) <= max_chars:
        return text, False
    cut = text[:max_chars].rsplit(' ', 1)[0]
    return cut + ' … [aperçu ; lire la source avant utilisation]', True


def build_view(connection, head, *, foundation_bytes=0, budget_bytes=VIEW_BUDGET_BYTES):
    """Build sourced indexes plus reserved thread and decision excerpts.

    A constraint excerpt is only an index entry: the complete source must be
    retrieved before applying it. If every source reference cannot fit, return
    an explicit blocked projection.
    A byte cap is exact; tokens are an estimate, never a provider tokenizer claim.
    """
    budget_bytes = max(4096, int(budget_bytes))
    counts = dict(connection.execute(f'SELECT kind,count(*) FROM events e WHERE {ACTIVE} AND {NOT_RETIRE_RECEIPT} GROUP BY kind'))
    lines = ['> Memory revision: ' + str(head), '> Projection version: 1', '',
             '> Vue active sourcée. Les aperçus ne sont pas des instructions complètes.',
             '> Lire un détail : context-retrieve.sh "EVT-<révision>". Historique complet consultable ; aucune fenêtre de récence.',
             '> Actifs : ' + ', '.join(f'{kind}={counts.get(kind, 0)}' for kind in KINDS), '']
    # Headers, blank lines and the final coverage marker are deliberately
    # accounted for before allocating the three content shares.
    framing_bytes = len('\n'.join(lines).encode()) + 700
    capacity = max(0, budget_bytes - foundation_bytes - framing_bytes)
    activity_limit = min(ACTIVITY_RESERVE_BYTES, capacity * 3 // 8)
    thread_limit = min(THREAD_RESERVE_BYTES, capacity // 4)
    constraint_limit = max(0, capacity - activity_limit - thread_limit)
    rendered_ids, critical_overflow, thread_overflow = [], [], []
    excerpts = 0
    # Decisions are not limited to the newest twelve. Reserve part of the
    # activity share for decisions older than two days, measured relative to
    # the newest event in the store (not the machine clock).
    decisions = [event(row) for row in connection.execute(
        f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND {NOT_RETIRE_RECEIPT} AND kind=? ORDER BY revision DESC',
        ('decision',))]
    dated = [event_datetime(item) for item in decisions]
    newest_row = connection.execute(
        f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND {NOT_RETIRE_RECEIPT} '
        'AND julianday(created_at) IS NOT NULL ORDER BY julianday(created_at) DESC LIMIT 1').fetchone()
    newest = event_datetime(event(newest_row)) if newest_row else None
    cutoff = newest - timedelta(days=2) if newest else None
    older, current = [], []
    for item, stamp in zip(decisions, dated):
        (older if cutoff and stamp and stamp < cutoff else current).append(item)
    # Preserve the established bounded recent slice. The separate older share
    # broadens temporal coverage without turning HYBRID into a decision dump.
    current = current[:RECENT_CAPS['decision']]
    candidates = []
    for kind, cap in RECENT_CAPS.items():
        if kind == 'decision':
            continue
        rows = connection.execute(
            f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND {NOT_RETIRE_RECEIPT} AND kind=? ORDER BY revision DESC LIMIT ?',
            (kind, cap * 4)).fetchall()
        candidates.append([item for item in map(event, rows) if not TELEMETRY.match(item['text'] or '')][:cap])
    current_queue = []
    groups = [current, *candidates]
    for index in range(max((len(group) for group in groups), default=0)):
        current_queue.extend(group[index] for group in groups if index < len(group))

    def activity_line(item):
        short, cut = excerpt(item['text'], 320 if item['kind'] == 'decision' else 240)
        line = f"- {day(item)} [{item['surface']}/{item['kind']}] {short} (EVT-{item['revision']}) <!-- context-event:{item['id']} -->"
        return item, line, cut

    def take(entries, limit):
        selected, cost = [], 0
        for item in entries:
            item, line, cut = activity_line(item)
            line_cost = len(line.encode()) + 1
            if cost + line_cost > limit:
                continue
            selected.append((item, line, cut)); cost += line_cost
        return selected, cost

    older_limit = min(OLDER_DECISION_RESERVE_BYTES, activity_limit // 3)
    old_selected, old_cost = take(older, older_limit)
    current_selected, current_cost = take(current_queue, activity_limit - old_cost)
    selected_old_ids = {item['id'] for item, _, _ in old_selected}
    extra_old, extra_old_cost = take(
        [item for item in older if item['id'] not in selected_old_ids],
        activity_limit - old_cost - current_cost)
    activity = current_selected + old_selected + extra_old
    activity_cost = current_cost + old_cost + extra_old_cost
    older_ids = {item['id'] for item in older}

    # Every thread retains a source reference. The newest threads receive long
    # excerpts while the four-KiB share allows it; this prevents a key detail at
    # character 91 from disappearing while keeping the index bounded.
    threads = [event(row) for row in connection.execute(
        f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND kind=? ORDER BY revision DESC', ('open_thread',))]
    thread_rows = []
    bare_cost = sum(len(f"- REQ-{item['revision']} [{item['surface']}]".encode()) + 1 for item in threads)
    detail_left = max(0, thread_limit - bare_cost)
    for item in threads:
        bare = f"- REQ-{item['revision']} [{item['surface']}]"
        short, cut = excerpt(item['text'], THREAD_EXCERPT_CHARS)
        detail = f" {day(item)} {short}"
        if len(detail.encode()) <= detail_left:
            line = bare + detail; detail_left -= len(detail.encode()); used_excerpt = cut
        else:
            line = bare; used_excerpt = False
        thread_rows.append((item, line, used_excerpt))
    thread_cost = sum(len(line.encode()) + 1 for _, line, _ in thread_rows)
    if thread_cost > thread_limit:
        kept, kept_cost = [], 0
        for item, _, _ in thread_rows:
            bare = f"- REQ-{item['revision']} [{item['surface']}]"
            cost = len(bare.encode()) + 1
            if kept_cost + cost <= thread_limit:
                kept.append((item, bare, False)); kept_cost += cost
            else:
                thread_overflow.append(item['revision'])
        thread_rows, thread_cost = kept, kept_cost
    excerpts += sum(int(cut) for _, _, cut in thread_rows)

    # An unused share is returned to the constraint index, without ever
    # borrowing the bytes already occupied by threads or activity.
    constraint_limit += max(0, activity_limit - activity_cost) + max(0, thread_limit - thread_cost)
    constraints = [event(row) for row in connection.execute(
        f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND kind=? ORDER BY revision DESC', ('constraint',))]
    constraint_rows = []
    constraint_bare_cost = sum(
        len(f"- EVT-{item['revision']} [{item['surface']}/constraint]".encode()) + 1 for item in constraints)
    constraint_detail_left = max(0, constraint_limit - constraint_bare_cost)
    for item in constraints:
        bare = f"- EVT-{item['revision']} [{item['surface']}/constraint]"
        short, cut = excerpt(item['text'], CONSTRAINT_EXCERPT_CHARS)
        detail = f" {day(item)} {short}"
        if len(detail.encode()) <= constraint_detail_left:
            line = bare + detail; constraint_detail_left -= len(detail.encode()); used_excerpt = cut
        else:
            line = bare; used_excerpt = False
        constraint_rows.append((item, line, used_excerpt))
    constraint_cost = sum(len(line.encode()) + 1 for _, line, _ in constraint_rows)
    if constraint_cost > constraint_limit:
        kept, kept_cost = [], 0
        for item, _, _ in constraint_rows:
            bare = f"- EVT-{item['revision']} [{item['surface']}/constraint]"
            cost = len(bare.encode()) + 1
            if kept_cost + cost <= constraint_limit:
                kept.append((item, bare, False)); kept_cost += cost
            else:
                critical_overflow.append(item['revision'])
        constraint_rows, constraint_cost = kept, kept_cost
    excerpts += sum(int(cut) for _, _, cut in constraint_rows)
    lines.append('### Active constraints — index sourcé ; lire EVT avant application')
    for item, line, _ in constraint_rows:
        lines.append(line); rendered_ids.append(item['id'])
    lines += ['', '### Open threads — index de tous les sujets encore actifs']
    for item, line, _ in thread_rows:
        lines.append(line)
        rendered_ids.append(item['id'])
    lines += ['', '### Activité et décisions récentes — détails sur demande']
    for item, line, cut in activity:
        lines.append(line); rendered_ids.append(item['id']); excerpts += int(cut)
    blocked = bool(critical_overflow or thread_overflow or foundation_bytes > budget_bytes)
    lines += ['', '> Coverage: ' + ('BLOCKED — budget insuffisant ; récupérer les éléments manquants ou augmenter le budget avant démarrage.' if blocked else COVERAGE_INDEX_COMPLETE)]
    body = '\n'.join(lines)
    if foundation_bytes + framing_bytes <= budget_bytes and foundation_bytes + len(body.encode()) > budget_bytes:
        raise AssertionError('hybrid_view_budget_exceeded')
    return body, {'version': 1, 'revision': head, 'budget_bytes': budget_bytes,
                  'active_counts': counts, 'rendered_events': len(rendered_ids), 'excerpts': excerpts,
                  'critical_overflow': critical_overflow[:50], 'thread_overflow': thread_overflow[:50],
                  'critical_overflow_count': len(critical_overflow), 'thread_overflow_count': len(thread_overflow),
                  'coverage_complete': not blocked,
                  'section_bytes': {'constraints': constraint_cost, 'threads': thread_cost, 'activity': activity_cost},
                  'reserved_bytes': {'threads': thread_limit, 'activity': activity_limit,
                                     'older_decisions': older_limit},
                  'older_decisions_rendered': sum(1 for item, _, _ in activity if item['id'] in older_ids),
                  'estimated_tokens': math.ceil((foundation_bytes + len(body.encode())) / 3),
                  'token_estimate_basis': 'UTF-8 bytes / 3; estimate only; hard bound is bytes'}


# Native Control reads the same immutable owner store; no separate memory registry.
def control_items(connection, query='', kind=None, offset=0, limit=20):
    if kind not in {None,'preference','decision','person','rule','import'} or len(query)>200 or not 0<=offset<=5000 or not 1<=limit<=50:
        raise ValueError('invalid_memory_query')
    source_kinds={'decision':'decision','rule':'constraint','import':'learning'}
    categories=[{'id':k,'available':k in source_kinds} for k in ('preference','decision','person','rule','import')]
    if kind in {'preference','person'}:return {'items':[], 'nextOffset':None, 'typedSourceAvailable':False,'categories':categories}
    selected=source_kinds.get(kind)
    # Imported learnings retain the owner's existing kind.
    filters=[ACTIVE,"(e.kind IN ('decision','constraint') OR (e.kind='learning' AND instr(e.text,'MEMORY_IMPORT_V1 ')=1))"]
    args=[]
    if selected:filters.append('e.kind=?');args.append(selected)
    if query:
        filters.append("e.text LIKE ? ESCAPE '\\'")
        args.append('%'+query.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%')
    rows=connection.execute(f"SELECT {COLUMNS} FROM events e WHERE {' AND '.join(filters)} ORDER BY e.revision DESC LIMIT ? OFFSET ?",(*args,limit+1,offset)).fetchall()
    def clean(value):
        if re.search(r'(?i)(token|password|secret|credential|authorization|otp|cvv|cvc|api[_ -]?key|iban|bank account)|(?:\d[ -]?){8,19}|https?://|[\w.+-]+@[\w.-]+',value):return 'Détail sensible masqué'
        return ' '.join(value.split())[:500]
    items=[]
    for row in rows[:limit]:
        text=row[4];source=None;original=None
        if row[3]=='learning':
            try:
                payload=json.loads(text[len('MEMORY_IMPORT_V1 '):])
                if not isinstance(payload,dict) or payload.get('source') not in {'chatgpt','claude'} or not isinstance(payload.get('text'),str):raise ValueError()
                text=payload['text'];source=payload['source']
                from context_import import stamp
                original=stamp(payload.get('originalCreatedAt'))
            except (ValueError,TypeError):text='Détail indisponible'
        items.append({'id':row[0],'text':clean(text),'kind':{'decision':'decision','constraint':'rule','learning':'import'}[row[3]],'createdAt':row[5],'source':source,'originalCreatedAt':original})
    return {'items':items,'nextOffset':offset+limit if len(rows)>limit else None,'typedSourceAvailable':True,'categories':categories}
