#!/data/data/com.termux/files/usr/bin/python3
"""Deterministic OpenClaw gateway preflight for the Termux runtime."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import socket
import time
from pathlib import Path

PLUGIN_ID = "openclaw-plugin-mobile-ui"


def _json(path: Path) -> dict:
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"expected JSON object: {path}")
    return data


def _schema_properties(manifest: Path) -> set[str]:
    data = _json(manifest)
    schema = data.get("configSchema") or {}
    props = schema.get("properties") or {}
    if not isinstance(props, dict):
        raise ValueError(f"invalid configSchema.properties: {manifest}")
    return set(props)


def plugin_schema_status(source_manifest: Path, installed_manifest: Path, config_path: Path,
                         plugin_id: str = PLUGIN_ID) -> dict:
    config = _json(config_path)
    entry = (((config.get("plugins") or {}).get("entries") or {}).get(plugin_id) or {})
    current = entry.get("config") or {}
    if not isinstance(current, dict):
        return {"state": "invalid_config", "reason": "plugin_config_not_object"}
    keys = set(current)
    if not source_manifest.is_file():
        return {"state": "invalid_source", "reason": "source_manifest_missing"}
    source = _schema_properties(source_manifest)
    unsupported = sorted(keys - source)
    if unsupported:
        return {"state": "unsupported", "unsupported": unsupported}
    if not installed_manifest.is_file():
        return {"state": "repairable", "reason": "installed_manifest_missing",
                "missing_installed": sorted(keys)}
    installed = _schema_properties(installed_manifest)
    missing = sorted(keys - installed)
    if missing:
        return {"state": "repairable", "reason": "installed_schema_stale",
                "missing_installed": missing}
    return {"state": "ok", "configured_keys": sorted(keys)}


def _created_epoch(raw: object) -> float | None:
    if not isinstance(raw, str):
        return None
    try:
        return dt.datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _proc_identity(proc_root: Path, pid: int) -> dict | None:
    try:
        root = proc_root / str(pid)
        stat = (root / "stat").read_text().rsplit(")", 1)[1].split()
        if stat[0] == "Z":
            return None
        args = (root / "cmdline").read_bytes().decode(errors="replace").split("\0")
        return {"pid": pid, "start_ticks": int(stat[19]), "args": [a for a in args if a]}
    except (OSError, ValueError, IndexError):
        return None


def _gateway_args(args: list[str]) -> bool:
    lowered = [Path(a).name.lower() for a in args]
    if any("openclaw-gateway" in a for a in lowered):
        return True
    joined = " ".join(a.lower() for a in args)
    return "openclaw" in joined and " gateway" in (" " + joined)


def _gateway_processes(proc_root: Path) -> list[dict]:
    rows = []
    try:
        children = list(proc_root.iterdir())
    except OSError:
        return rows
    for child in children:
        if not child.name.isdigit():
            continue
        row = _proc_identity(proc_root, int(child.name))
        if row and _gateway_args(row["args"]):
            rows.append(row)
    return rows


def _port_open(port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def stale_gateway_lock_status(state_dir: Path, config_path: Path, port: int,
                              proc_root: Path = Path("/proc"), now: float | None = None,
                              stale_s: int = 60, port_probe=None) -> dict:
    now = time.time() if now is None else now
    port_probe = port_probe or _port_open
    lock_dir = state_dir / "tmp" / f"openclaw-{os.getuid()}"
    state_lock = lock_dir / "gateway.state.lock"
    if not state_lock.is_file():
        return {"state": "no_lock", "lock_dir": str(lock_dir)}
    try:
        state_payload = _json(state_lock)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"state": "unsafe", "reason": "state_lock_unreadable", "detail": type(exc).__name__}

    candidates = []
    for path in lock_dir.glob("gateway.*.lock"):
        if path.name == "gateway.state.lock":
            continue
        try:
            payload = _json(path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        try:
            same_config = Path(str(payload.get("configPath", ""))).resolve() == config_path.resolve()
            same_state = Path(str(payload.get("stateDir", ""))).resolve() == state_dir.resolve()
        except OSError:
            same_config = same_state = False
        if same_config and same_state and int(payload.get("port", 0) or 0) == port:
            candidates.append((path, payload))
    if len(candidates) != 1:
        return {"state": "unsafe", "reason": "config_lock_ambiguous", "count": len(candidates)}

    config_lock, config_payload = candidates[0]
    identity = ("pid", "ownerId", "startTime")
    if any(config_payload.get(k) != state_payload.get(k) for k in identity):
        return {"state": "unsafe", "reason": "lock_identity_mismatch"}

    pid = int(state_payload.get("pid", 0) or 0)
    created = min(filter(lambda x: x is not None, (
        _created_epoch(state_payload.get("createdAt")),
        _created_epoch(config_payload.get("createdAt")),
    )), default=None)
    if pid <= 0 or created is None:
        return {"state": "unsafe", "reason": "lock_identity_incomplete"}
    age = now - created
    if age < stale_s:
        return {"state": "young_lock", "pid": pid, "age_s": round(age, 3)}

    owner = _proc_identity(proc_root, pid)
    expected_start = state_payload.get("startTime")
    if owner and owner["start_ticks"] == expected_start and _gateway_args(owner["args"]):
        return {"state": "active_owner", "pid": pid, "age_s": round(age, 3)}
    live = _gateway_processes(proc_root)
    if live:
        return {"state": "active_gateway", "pids": [r["pid"] for r in live]}
    if port_probe(port):
        return {"state": "active_listener", "port": port}

    paths = [config_lock, state_lock]
    return {
        "state": "stale_recoverable",
        "pid": pid,
        "owner_id": state_payload.get("ownerId"),
        "age_s": round(age, 3),
        "paths": [str(p) for p in paths],
        "reason": "owner_identity_not_live_and_gateway_not_listening",
    }


def recover_stale_gateway_locks(state_dir: Path, config_path: Path, port: int,
                                proc_root: Path = Path("/proc"), stale_s: int = 60,
                                backup_root: Path | None = None, port_probe=None) -> dict:
    status = stale_gateway_lock_status(
        state_dir, config_path, port, proc_root=proc_root, stale_s=stale_s, port_probe=port_probe
    )
    if status.get("state") != "stale_recoverable":
        return status
    # Re-evaluate immediately before mutation to narrow the race window.
    confirmed = stale_gateway_lock_status(
        state_dir, config_path, port, proc_root=proc_root, stale_s=stale_s, port_probe=port_probe
    )
    if confirmed.get("state") != "stale_recoverable" or confirmed.get("pid") != status.get("pid"):
        return {"state": "unsafe", "reason": "lock_state_changed_before_recovery"}

    backup_root = backup_root or (state_dir / "backups")
    stamp = dt.datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    dest = backup_root / f"gateway-lock-recovery-{stamp}"
    dest.mkdir(parents=True, exist_ok=False)
    moved = []
    for raw in confirmed["paths"]:
        path = Path(raw)
        for candidate in (path, Path(str(path) + ".sqlite")):
            if candidate.exists():
                target = dest / candidate.name
                os.replace(candidate, target)
                moved.append(str(target))
    return {"state": "recovered", "pid": status["pid"], "backup": str(dest), "moved": moved}


def _pid_owner(pid: int, kill=os.kill) -> str:
    """'ours', 'gone' or 'foreign'. On Android every process of this uid is
    signalable; EPERM means the PID now belongs to another app, so it cannot be
    an OpenClaw process. OpenClaw itself only treats ESRCH as proof of death."""
    if pid <= 0:
        return "gone"
    try:
        kill(pid, 0)
    except ProcessLookupError:
        return "gone"
    except PermissionError:
        return "foreign"
    return "ours"


def _foreign_agent_leases(db, kill=os.kill) -> list[dict]:
    exists = db.execute("select 1 from sqlite_master where type='table' and name='agent_database_leases'").fetchone()
    if not exists:
        return []
    rows = db.execute("select lease_id, agent_id, path, owner_pid, owner_start_time from agent_database_leases").fetchall()
    keys = ("lease_id", "agent_id", "path", "owner_pid", "owner_start_time")
    return [dict(zip(keys, r)) for r in rows if _pid_owner(int(r[3] or 0), kill) == "foreign"]


def recover_foreign_agent_leases(state_dir: Path, proc_root: Path = Path("/proc"),
                                 backup_root: Path | None = None, kill=os.kill,
                                 apply: bool = True) -> dict:
    """Release agent database leases left by a dead OpenClaw process whose PID
    was reused by another Android app (incident 28/10: Doctor refused every
    Gateway start). Only those rows are touched, only while no Gateway runs."""
    import sqlite3
    database = state_dir / "state" / "openclaw.sqlite"
    if not database.is_file():
        return {"state": "no_state_database"}
    live = _gateway_processes(proc_root)
    if live:
        return {"state": "active_gateway", "pids": [r["pid"] for r in live]}
    db = sqlite3.connect(database, timeout=5, isolation_level=None)
    try:
        foreign = _foreign_agent_leases(db, kill)
        if not foreign:
            return {"state": "ok"}
        if not apply:
            return {"state": "foreign_leases", "leases": foreign}
        db.execute("begin immediate")
        try:
            confirmed = {r["lease_id"]: r for r in _foreign_agent_leases(db, kill)}
            stale = [r for r in foreign if confirmed.get(r["lease_id"]) == r]
            for row in stale:
                db.execute("delete from agent_database_leases where lease_id=? and owner_pid=?",
                           (row["lease_id"], row["owner_pid"]))
            db.execute("commit")
        except BaseException:
            db.execute("rollback")
            raise
    finally:
        db.close()
    backup_root = backup_root or (state_dir / "backups")
    backup_root.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    receipt = backup_root / f"agent-lease-recovery-{stamp}.json"
    receipt.write_text(json.dumps({"reason": "owner_pid_belongs_to_another_uid", "leases": stale}, indent=2))
    os.chmod(receipt, 0o600)
    # Same effect as OpenClaw's own stale-lease release: the next open re-verifies integrity.
    cleared = 0
    quarantine = state_dir / "state" / "openclaw-quarantine.sqlite"
    if stale and quarantine.is_file():
        qdb = sqlite3.connect(quarantine, timeout=5)
        try:
            if qdb.execute("select 1 from sqlite_master where type='table' and name='agent_integrity_verifications'").fetchone():
                for path in {r["path"] for r in stale}:
                    cleared += qdb.execute("delete from agent_integrity_verifications where path in (?, ?)",
                                           (path, os.path.realpath(path))).rowcount
                qdb.commit()
        finally:
            qdb.close()
    return {"state": "recovered" if stale else "ok", "released": len(stale),
            "verifications_cleared": cleared, "receipt": str(receipt)}


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    schema = sub.add_parser("plugin-schema")
    schema.add_argument("--source-manifest", type=Path, required=True)
    schema.add_argument("--installed-manifest", type=Path, required=True)
    schema.add_argument("--config", type=Path, required=True)
    schema.add_argument("--plugin-id", default=PLUGIN_ID)

    locks = sub.add_parser("stale-locks")
    locks.add_argument("--state-dir", type=Path, required=True)
    locks.add_argument("--config", type=Path, required=True)
    locks.add_argument("--port", type=int, required=True)
    locks.add_argument("--stale-s", type=int, default=60)
    locks.add_argument("--apply", action="store_true")

    leases = sub.add_parser("agent-leases")
    leases.add_argument("--state-dir", type=Path, required=True)
    leases.add_argument("--apply", action="store_true")

    args = parser.parse_args()
    if args.command == "plugin-schema":
        result = plugin_schema_status(args.source_manifest, args.installed_manifest, args.config, args.plugin_id)
    elif args.command == "agent-leases":
        result = recover_foreign_agent_leases(args.state_dir, apply=args.apply)
    elif args.apply:
        result = recover_stale_gateway_locks(args.state_dir, args.config, args.port, stale_s=args.stale_s)
    else:
        result = stale_gateway_lock_status(args.state_dir, args.config, args.port, stale_s=args.stale_s)
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get("state") in {"ok", "no_lock", "young_lock", "active_owner", "active_gateway", "active_listener", "recovered", "repairable", "no_state_database"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
