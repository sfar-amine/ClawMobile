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

KINDS = ('constraint', 'open_thread', 'decision', 'learning', 'completed_action', 'checkpoint')
COLUMNS = 'e.id,e.revision,e.surface,e.kind,e.text,e.created_at,e.supersedes'
ACTIVE = "NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes=e.id)"
VIEW_BUDGET_BYTES = 24576
RECENT_CAPS = {'decision': 12, 'learning': 8, 'completed_action': 5, 'checkpoint': 3}


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
    filters, parameters = ([] if history else [ACTIVE]), []
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
    """Prioritize complete constraints and an all-age index of open threads.

    If essential coverage cannot fit, return an explicit blocked projection.
    A byte cap is exact; tokens are an estimate, never a provider tokenizer claim.
    """
    budget_bytes = max(4096, int(budget_bytes))
    counts = dict(connection.execute(f'SELECT kind,count(*) FROM events e WHERE {ACTIVE} GROUP BY kind'))
    lines = ['> Memory revision: ' + str(head), '> Projection version: 1', '',
             '> Vue active sourcée. Les aperçus ne sont pas des instructions complètes.',
             '> Lire un détail : context-retrieve.sh "EVT-<révision>". Historique complet consultable ; aucune fenêtre de récence.',
             '> Actifs : ' + ', '.join(f'{kind}={counts.get(kind, 0)}' for kind in KINDS), '']
    used = foundation_bytes + len('\n'.join(lines).encode()) + 600
    rendered_ids, critical_overflow, thread_overflow = [], [], []
    excerpts = 0
    # Complete constraints first: do not lose negations, scope or authorization.
    lines.append('### Active constraints — texte intégral')
    for row in connection.execute(f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND kind=? ORDER BY revision', ('constraint',)):
        item = event(row)
        line = f"- [{item['surface']}/constraint] {item['text']} (EVT-{item['revision']}) <!-- context-event:{item['id']} -->"
        cost = len(line.encode()) + 1
        if used + cost <= budget_bytes:
            lines.append(line); used += cost; rendered_ids.append(item['id'])
        else:
            critical_overflow.append(item['revision'])
    lines += ['', '### Open threads — index de tous les sujets encore actifs']
    for row in connection.execute(f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND kind=? ORDER BY revision', ('open_thread',)):
        item = event(row); short, cut = excerpt(item['text'], 140)
        line = f"- REQ-{item['revision']} [{item['surface']}] {short}"
        cost = len(line.encode()) + 1
        if used + cost <= budget_bytes:
            lines.append(line); used += cost; rendered_ids.append(item['id']); excerpts += int(cut)
        else:
            thread_overflow.append(item['revision'])
    # Fair sharing of the remaining budget; never displace mandatory coverage.
    candidates = []
    for kind, cap in RECENT_CAPS.items():
        rows = connection.execute(f'SELECT {COLUMNS} FROM events e WHERE {ACTIVE} AND kind=? ORDER BY revision DESC LIMIT ?', (kind, cap)).fetchall()
        candidates.append([event(row) for row in rows])
    lines += ['', '### Activité et décisions récentes — détails sur demande']
    for index in range(max(RECENT_CAPS.values())):
        for group in candidates:
            if index >= len(group):
                continue
            item = group[index]; short, cut = excerpt(item['text'], 240)
            line = f"- [{item['surface']}/{item['kind']}] {short} (EVT-{item['revision']}) <!-- context-event:{item['id']} -->"
            cost = len(line.encode()) + 1
            if used + cost <= budget_bytes:
                lines.append(line); used += cost; rendered_ids.append(item['id']); excerpts += int(cut)
    blocked = bool(critical_overflow or thread_overflow or foundation_bytes > budget_bytes)
    lines += ['', '> Coverage: ' + ('BLOCKED — budget insuffisant ; récupérer les éléments manquants ou augmenter le budget avant démarrage.' if blocked else 'constraints_complete; open_thread_index_complete')]
    body = '\n'.join(lines)
    return body, {'version': 1, 'revision': head, 'budget_bytes': budget_bytes,
                  'active_counts': counts, 'rendered_events': len(rendered_ids), 'excerpts': excerpts,
                  'critical_overflow': critical_overflow[:50], 'thread_overflow': thread_overflow[:50],
                  'critical_overflow_count': len(critical_overflow), 'thread_overflow_count': len(thread_overflow),
                  'coverage_complete': not blocked,
                  'estimated_tokens': math.ceil((foundation_bytes + len(body.encode())) / 3),
                  'token_estimate_basis': 'UTF-8 bytes / 3; estimate only; hard bound is bytes'}
