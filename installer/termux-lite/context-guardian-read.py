#!/usr/bin/env python3
"""Read the existing agent session owner without starting the OpenClaw Node CLI.

Only session_nodes.session_key/entry_json are queried. stdout is the existing private
Guardian health projection; stderr contains fixed codes only, never paths or entries.
"""
import argparse
from contextlib import closing
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
import time

MAX_AGENTS = 128
MAX_ROWS = 10000
MAX_ENTRY_BYTES = 65536
MAX_OUTPUT_BYTES = 8 << 20
READ_SECONDS = 8
IDENTITY = re.compile(r"^[A-Za-z0-9:_+.@-]{1,200}$")
AGENT = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class Unavailable(Exception):
    pass


def numeric(value, default=0):
    try:
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else default
    except OverflowError:
        return default


def read_health(agents_root, *, now_ms=None):
    deadline = time.monotonic() + READ_SECONDS
    root = Path(agents_root)
    if any(part.is_symlink() for part in (root, *root.parents)) or not root.is_dir():
        raise Unavailable("session_source_unavailable")
    roots = []
    for entry in root.iterdir():
        if time.monotonic() >= deadline:
            raise Unavailable("session_read_budget")
        if len(roots) >= MAX_AGENTS:
            raise Unavailable("session_agent_limit")
        roots.append(entry)
    roots.sort(key=lambda p: p.name)
    rows, keys, databases = [], set(), 0
    for agent in roots:
        if time.monotonic() >= deadline:
            raise Unavailable("session_read_budget")
        if not AGENT.fullmatch(agent.name) or agent.is_symlink() or not agent.is_dir():
            continue
        folder = agent / "agent"
        database = folder / "openclaw-agent.sqlite"
        if folder.is_symlink() or any(file.is_symlink() for file in (database, database.with_name(database.name + "-wal"), database.with_name(database.name + "-shm"))):
            raise Unavailable("session_source_unavailable")
        if not database.exists():
            continue
        if not database.is_file():
            raise Unavailable("session_source_unavailable")
        databases += 1
        uri = database.resolve().as_uri() + "?mode=ro"
        try:
            with closing(sqlite3.connect(uri, uri=True, timeout=.25)) as conn:
                conn.execute("PRAGMA query_only=ON")
                # Reject oversized native SQLite values before materializing them in C or Python.
                if not hasattr(conn, "setlimit"):
                    raise Unavailable("session_reader_limit_unavailable")
                conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_ENTRY_BYTES + 1024)
                conn.set_progress_handler(lambda: 1 if time.monotonic() >= deadline else 0, 1000)
                # No promoted indexes, session_windows, transcript messages or guessed JSON columns.
                for key, raw in conn.execute("SELECT session_key, CASE WHEN length(CAST(entry_json AS BLOB)) <= ? THEN entry_json ELSE NULL END FROM session_nodes", (MAX_ENTRY_BYTES,)):
                    if time.monotonic() >= deadline:
                        raise Unavailable("session_read_budget")
                    if len(rows) >= MAX_ROWS:
                        raise Unavailable("session_row_limit")
                    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_ENTRY_BYTES:
                        raise Unavailable("session_entry_invalid")
                    entry = json.loads(raw)
                    if not isinstance(entry, dict) or not isinstance(key, str) or not IDENTITY.fullmatch(key) or key in keys:
                        raise Unavailable("session_entry_invalid")
                    keys.add(key)
                    sid = entry.get("sessionId")
                    if sid is not None and (not isinstance(sid, str) or not IDENTITY.fullmatch(sid)):
                        raise Unavailable("session_entry_invalid")
                    total, context = numeric(entry.get("totalTokens")), numeric(entry.get("contextTokens"))
                    ratio = total / context if context else None
                    if ratio is not None and not math.isfinite(ratio):
                        ratio = None
                    kind = entry.get("kind")
                    if kind is not None and (not isinstance(kind, str) or not re.fullmatch(r"[A-Za-z_-]{1,40}", kind)):
                        kind = None
                    status = entry.get("status")
                    if status not in ("running", "done", "failed", "killed", "timeout"):
                        status = None
                    rows.append({"key": key, "sessionId": sid, "updatedAt": numeric(entry.get("updatedAt"), None),
                                 "totalTokens": total, "contextTokens": context,
                                 "ratio": ratio,
                                 "kind": kind, "status": status,
                                 "compactionCount": numeric(entry.get("compactionCount"), None)})
        except (sqlite3.Error, OSError, ValueError, TypeError, RecursionError):
            raise Unavailable("session_source_unavailable") from None
    if not databases:
        raise Unavailable("session_source_unavailable")
    rows.sort(key=lambda row: (-(row["updatedAt"] or 0), row["key"]))
    output = json.dumps({"version": 1, "checkedAtMs": int(time.time() * 1000) if now_ms is None else now_ms,
                         "sessions": rows}, separators=(",", ":"), allow_nan=False)
    if time.monotonic() >= deadline:
        raise Unavailable("session_read_budget")
    if len(output.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise Unavailable("session_output_limit")
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agents-root", required=True)
    args = parser.parse_args()
    try:
        print(read_health(args.agents_root))
        return 0
    except (Unavailable, OSError):
        # No raw SQLite errors, directory names, entry strings or exception diagnostics in logs.
        print("guardian_session_read_unavailable", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
