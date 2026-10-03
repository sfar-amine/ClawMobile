#!/data/data/com.termux/files/usr/bin/python3
"""Full-history indexed retrieval from the canonical store, read-only."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
from context_memory import KINDS, search


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('query'); p.add_argument('limit', nargs='?', type=int, default=12)
    p.add_argument('--history', action='store_true')
    p.add_argument('--kind', choices=KINDS)
    p.add_argument('--offset', type=int, default=0)
    a = p.parse_args()
    db = Path(os.environ.get('SAMANTHA_CONTEXT_ROOT', Path.home() / '.openclaw/context-sync')) / 'memory.db'
    with closing(sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as c:
        c.execute('BEGIN')
        result = search(c, a.query, a.limit, history=a.history, kind=a.kind, offset=a.offset)
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
