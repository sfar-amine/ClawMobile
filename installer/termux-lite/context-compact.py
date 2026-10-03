#!/data/data/com.termux/files/usr/bin/python3
"""Materialize a bounded, all-age active view through the existing writer lock."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

from context_memory import build_view, VIEW_BUDGET_BYTES

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('context_store', HERE / 'context-store.py')
store = importlib.util.module_from_spec(spec); spec.loader.exec_module(store)
D = store.D; Q = D / 'pending'; P = D / 'processed'; S = D / 'state'; A = D / 'history'
HY = Path(os.environ.get('SAMANTHA_HYBRID_PATH', Path.home() / '.openclaw/workspace/context/HYBRID_CONTEXT.md'))
START = '<!-- SAMANTHA_MEMORY_VIEW_START -->'; END = '<!-- SAMANTHA_MEMORY_VIEW_END -->'


def main():
    for p in (D, Q, P, S, A, HY.parent): p.mkdir(parents=True, exist_ok=True)
    con = store.connect(); store.migrate(con)
    marker = con.execute("SELECT value FROM memory_meta WHERE key='processed_reconciled_v1'").fetchone()
    pending = sorted(Q.glob('*.json'))
    # A fresh/restored DB reconstructs all accepted events. Routine compaction
    # never reopens every processed JSON file on each user turn.
    reconcile = marker is None or '--reconcile-history' in sys.argv
    sources = (sorted(P.glob('*.json')) if reconcile else []) + pending
    invalid = []; accepted = 0
    for p in sources:
        try:
            result = store.ingest_file(con, p)
            accepted += int(result['inserted'])
        except Exception as exc:
            invalid.append((str(p), str(exc)))
    if reconcile and not invalid:
        con.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('processed_reconciled_v1','1')")
    old = HY.read_text() if HY.exists() else '# Claw Hybrid Conversation Context — Amine\n'
    if old.count(START) == 1 and old.count(END) == 1:
        pre, rest = old.split(START, 1); _, post = rest.split(END, 1)
        pre = pre.rstrip(); post = post.lstrip()
    elif START in old or END in old:
        raise ValueError('ambiguous_global_view_markers')
    else:
        # Legacy foundation is retained, not silently erased.
        pre, post = old.rstrip(), ''
    now = datetime.datetime.now().astimezone()
    prefix = START + '\n## Bounded cross-surface memory view — ' + now.strftime('%Y-%m-%d %H:%M %z') + '\n\n'
    foundation_bytes = len((pre + '\n\n' + prefix + '\n' + END + '\n' + post).encode())
    con.execute('BEGIN')
    try:
        head = con.execute('SELECT COALESCE(MAX(revision),0) FROM events').fetchone()[0]
        body, meta = build_view(con, head, foundation_bytes=foundation_bytes,
                                budget_bytes=int(os.environ.get('SAMANTHA_CONTEXT_VIEW_BYTES', VIEW_BUDGET_BYTES)))
        indexed = con.execute('SELECT count(*) FROM events').fetchone()[0]
    finally:
        con.execute('COMMIT')
    new = pre + '\n\n' + prefix + body + '\n' + END + '\n' + (('\n' + post) if post else '')
    meta.update(bytes=len(new.encode()), sha256=hashlib.sha256(new.encode()).hexdigest())
    if meta['bytes'] > meta['budget_bytes']:
        meta['coverage_complete'] = False
        meta['budget_exceeded'] = True
    fd, tmp = tempfile.mkstemp(prefix='hybrid.', dir=str(HY.parent))
    try:
        with os.fdopen(fd, 'w') as f: f.write(new)
        os.chmod(tmp, 0o600); os.replace(tmp, HY)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    con.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('view_projection_v1',?)", (json.dumps(meta, separators=(',', ':')),))
    con.close()
    (S / 'last_compaction').write_text(now.isoformat() + '\n')
    print(json.dumps({'pending_seen': len(pending), 'accepted': accepted, 'invalid': len(invalid),
                      'indexed': indexed, 'view_events': meta['rendered_events'], 'head_revision': head,
                      'processed_reconciled': reconcile, 'projection': meta}, separators=(',', ':')))
    if invalid:
        for p, error in invalid: print(f'invalid event retained: {p}: {error}', file=sys.stderr)
        return 65
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
