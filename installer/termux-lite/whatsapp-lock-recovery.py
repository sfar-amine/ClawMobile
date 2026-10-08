#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse, datetime as dt, json, os, sys, time
from pathlib import Path


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def proc_starttime(proc_root: Path, pid: int) -> int | None:
    path = proc_root / str(pid) / "stat"
    try:
        raw = path.read_text()
    except OSError:
        return None
    end = raw.rfind(")")
    if end < 0:
        return None
    fields = raw[end + 2 :].split()
    try:
        return int(fields[19])  # Linux /proc/<pid>/stat field 22
    except (IndexError, ValueError):
        return None


def main() -> int:
    home = Path.home()
    ap = argparse.ArgumentParser()
    ap.add_argument("--lock", type=Path, default=home / ".openclaw/credentials/whatsapp/default.lock")
    ap.add_argument("--quarantine-dir", type=Path, default=home / ".openclaw/health/quarantine")
    ap.add_argument("--receipt", type=Path, default=home / ".openclaw/health/whatsapp-lock-recovery.json")
    ap.add_argument("--proc-root", type=Path, default=Path("/proc"))
    ap.add_argument("--grace-seconds", type=int, default=120)
    args = ap.parse_args()
    now = time.time()
    base = {"version": 1, "checked_at": now, "lock": str(args.lock), "effect_replayed": False}
    if not args.lock.exists():
        out = {**base, "state": "no_lock", "changed": False}
        atomic_json(args.receipt, out); print(json.dumps(out)); return 0
    try:
        stat = args.lock.stat()
        data = json.loads(args.lock.read_text())
        pid = int(data["pid"]); recorded = int(data["starttime"])
        if pid <= 0 or recorded <= 0:
            raise ValueError("invalid_owner_identity")
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        out = {**base, "state": "refused_malformed", "changed": False, "reason": type(exc).__name__}
        atomic_json(args.receipt, out); print(json.dumps(out)); return 30
    age = max(0.0, now - stat.st_mtime)
    live = proc_starttime(args.proc_root, pid)
    if live == recorded:
        out = {**base, "state": "active_owner", "changed": False, "pid": pid, "age_s": round(age, 3)}
        atomic_json(args.receipt, out); print(json.dumps(out)); return 20
    if age < max(30, args.grace_seconds):
        out = {**base, "state": "recent_unowned", "changed": False, "pid": pid, "age_s": round(age, 3)}
        atomic_json(args.receipt, out); print(json.dumps(out)); return 0
    reason = "dead_pid" if live is None else "pid_reused"
    args.quarantine_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = args.quarantine_dir / f"whatsapp-default.lock.{int(now)}.{pid}.json"
    os.replace(args.lock, target)
    out = {**base, "state": "quarantined", "changed": True, "reason": reason, "pid": pid,
           "recorded_starttime": recorded, "live_starttime": live, "age_s": round(age, 3),
           "quarantine": str(target)}
    atomic_json(args.receipt, out); print(json.dumps(out)); return 10


if __name__ == "__main__":
    raise SystemExit(main())
