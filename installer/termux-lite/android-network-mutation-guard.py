#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

HOME = Path.home()
ROOT = HOME / ".openclaw" / "network-mutation"
LEASES = ROOT / "leases"
RECEIPT = HOME / ".openclaw" / "health" / "network-mutation-safety.json"
ADB_ENDPOINT = os.environ.get("SAMANTHA_ADB_ENDPOINT", "127.0.0.1:5556")
ADB = ["adb", "-s", ADB_ENDPOINT]
KEYS = (
    "http_proxy",
    "global_http_proxy_host",
    "global_http_proxy_port",
    "global_http_proxy_exclusion_list",
    "global_proxy_pac_url",
)
MAX_LEASE_AGE = int(os.environ.get("NETWORK_MUTATION_MAX_LEASE_AGE", "900"))
TERMUX_PACKAGES = ("com.termux", "com.termux.api", "com.termux.boot")

def adb(*args: str, timeout: int = 6, check: bool = False) -> subprocess.CompletedProcess:
    p = subprocess.run(ADB + list(args), text=True, capture_output=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError("adb_command_failed")
    return p

def settings_state() -> dict:
    raw = adb("shell", "settings", "list", "global", check=True).stdout
    rows = {}
    for line in raw.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            rows[key] = value
    return {key: {"exists": key in rows, "value": rows.get(key)} for key in KEYS}

def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

def restore_state(state: dict) -> None:
    for key in KEYS:
        row = state[key]
        if row["exists"]:
            adb("shell", "settings", "put", "global", key, row["value"] or "", check=True)
        else:
            adb("shell", "settings", "delete", "global", key, check=True)
    if settings_state() != state:
        raise RuntimeError("network_settings_restore_mismatch")

def proxy_active(state: dict) -> bool:
    hp = (state["http_proxy"]["value"] or "").strip().lower()
    host = (state["global_http_proxy_host"]["value"] or "").strip().lower()
    port = (state["global_http_proxy_port"]["value"] or "").strip().lower()
    pac = (state["global_proxy_pac_url"]["value"] or "").strip().lower()
    return hp not in ("", "null", ":0") or host not in ("", "null") or port not in ("", "null") or pac not in ("", "null")

def _allow_mode(text: str, op: str) -> bool:
    return f"{op}: allow" in text or "Default mode: allow" in text

def installed_termux_packages() -> dict[str, int]:
    raw = adb("shell", "pm", "list", "packages", "-U", "com.termux", check=True).stdout
    rows = {}
    for line in raw.splitlines():
        m = re.fullmatch(r"package:(\S+)\s+uid:(\d+)", line.strip())
        if m and m.group(1) in TERMUX_PACKAGES:
            rows[m.group(1)] = int(m.group(2))
    if "com.termux" not in rows:
        raise RuntimeError("termux_package_missing")
    return rows

def termux_background_state() -> dict:
    packages = installed_termux_packages()
    idle_raw = adb("shell", "dumpsys", "deviceidle", "whitelist", check=True).stdout
    net_raw = adb("shell", "cmd", "netpolicy", "list", "restrict-background-whitelist", check=True).stdout
    whitelisted_uids = {int(x) for x in re.findall(r"\b\d+\b", net_raw.split(":", 1)[-1])}
    details = {}
    for pkg, uid in packages.items():
        any_bg = adb("shell", "cmd", "appops", "get", pkg, "RUN_ANY_IN_BACKGROUND")
        run_bg = adb("shell", "cmd", "appops", "get", pkg, "RUN_IN_BACKGROUND")
        inactive = adb("shell", "am", "get-inactive", pkg, check=True).stdout.strip().lower()
        bucket_raw = adb("shell", "am", "get-standby-bucket", pkg, check=True).stdout.strip()
        try: bucket = int(bucket_raw)
        except ValueError: bucket = 999
        h = adb("shell", "cmd", "app_hibernation", "get-state", pkg)
        h_text = h.stdout.strip().lower()
        h_supported = h.returncode == 0 and h_text in {"true", "false"}
        row = {
            "uid": uid,
            "doze_whitelisted": f"user,{pkg},{uid}" in idle_raw.splitlines(),
            "run_any_in_background": any_bg.returncode == 0 and _allow_mode(any_bg.stdout, "RUN_ANY_IN_BACKGROUND"),
            "run_in_background": run_bg.returncode == 0 and _allow_mode(run_bg.stdout, "RUN_IN_BACKGROUND"),
            "inactive": "idle=true" in inactive,
            "standby_bucket": bucket,
            "hibernation_supported": h_supported,
            "hibernated": h_text == "true" if h_supported else False,
        }
        row["healthy"] = (row["doze_whitelisted"] and row["run_any_in_background"] and
                          row["run_in_background"] and not row["inactive"] and
                          row["standby_bucket"] <= 10 and
                          (not h_supported or not row["hibernated"]))
        details[pkg] = row
    uids = sorted(set(packages.values()))
    data_saver = {str(uid): uid in whitelisted_uids for uid in uids}
    healthy = all(r["healthy"] for r in details.values()) and all(data_saver.values())
    return {"healthy": healthy, "packages": details, "data_saver_whitelisted": data_saver}

def repair_termux_background(state: dict) -> None:
    repaired_uids = set()
    for pkg, row in state["packages"].items():
        uid = int(row["uid"])
        if not row["doze_whitelisted"]:
            adb("shell", "dumpsys", "deviceidle", "whitelist", "+" + pkg, check=True)
        if not row["run_any_in_background"]:
            adb("shell", "cmd", "appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", "allow", check=True)
        if not row["run_in_background"]:
            adb("shell", "cmd", "appops", "set", pkg, "RUN_IN_BACKGROUND", "allow", check=True)
        if row["inactive"] or int(row["standby_bucket"]) > 10:
            adb("shell", "am", "set-inactive", pkg, "false", check=True)
            adb("shell", "am", "set-standby-bucket", pkg, "active", check=True)
        if row["hibernation_supported"] and row["hibernated"]:
            adb("shell", "cmd", "app_hibernation", "set-state", pkg, "false", check=True)
        if not state["data_saver_whitelisted"].get(str(uid), False) and uid not in repaired_uids:
            adb("shell", "cmd", "netpolicy", "add", "restrict-background-whitelist", str(uid), check=True)
            repaired_uids.add(uid)

def ensure_termux_background_network() -> dict:
    before = termux_background_state()
    if before["healthy"]:
        return {"state": "healthy", "mutation": "none", "details": before}
    repair_termux_background(before)
    after = termux_background_state()
    if not after["healthy"]:
        raise RuntimeError("termux_background_policy_repair_mismatch")
    return {"state": "healthy", "mutation": "repaired", "details": after}

def lease_alive(row: dict) -> bool:
    pid = int(row.get("owner_pid") or 0)
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def create_lease(purpose: str) -> Path:
    LEASES.mkdir(parents=True, exist_ok=True)
    lease = LEASES / (uuid.uuid4().hex + ".json")
    row = {
        "schema_version": 1,
        "created_at": time.time(),
        "owner_pid": os.getpid(),
        "purpose": purpose,
        "settings": settings_state(),
    }
    write_json(lease, row)
    return lease

def write_receipt(state: str, reason: str, **extra) -> None:
    write_json(RECEIPT, {
        "schema_version": 1,
        "checked_at": time.time(),
        "state": state,
        "reason": reason,
        **extra,
    })

def check_and_reconcile(reconcile_background: bool = True) -> int:
    LEASES.mkdir(parents=True, exist_ok=True)
    active = []
    recovered = []
    errors = []
    now = time.time()
    for lease in sorted(LEASES.glob("*.json")):
        try:
            row = json.loads(lease.read_text())
            age = max(0, now - float(row.get("created_at", 0)))
            if lease_alive(row) and age <= MAX_LEASE_AGE:
                active.append(lease.name)
                continue
            restore_state(row["settings"])
            lease.unlink()
            recovered.append(lease.name)
        except Exception as exc:
            errors.append({"lease": lease.name, "error": type(exc).__name__})
    current = settings_state()
    unmanaged = proxy_active(current) and not active
    if errors:
        write_receipt("degraded", "stale_lease_restore_failed", active_leases=active, errors=errors)
        return 2
    if unmanaged:
        write_receipt("degraded", "unmanaged_global_proxy_detected", active_leases=active)
        return 2
    background = {"state": "skipped", "mutation": "none", "details": {}}
    if reconcile_background:
        try:
            background = ensure_termux_background_network()
        except Exception as exc:
            write_receipt("degraded", "termux_background_policy_repair_failed", active_leases=active, error=type(exc).__name__)
            return 2
    if background.get("mutation") == "repaired":
        reason = "termux_background_policy_repaired"
    else:
        reason = "temporary_lease_active" if active else ("stale_lease_restored" if recovered else "network_settings_clean")
    write_receipt("healthy", reason, active_leases=active, recovered_leases=recovered, termux_background=background)
    return 0

def with_global_proxy(endpoint: str, purpose: str, command: list[str]) -> int:
    lease = create_lease(purpose)
    row = json.loads(lease.read_text())
    restore_error = None
    def interrupted(_sig, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        adb("shell", "settings", "put", "global", "http_proxy", endpoint, check=True)
        child = subprocess.run(command)
        return child.returncode
    finally:
        try:
            restore_state(row["settings"])
            lease.unlink(missing_ok=True)
            write_receipt("healthy", "temporary_proxy_restored")
        except Exception as exc:
            restore_error = type(exc).__name__
            write_receipt("degraded", "temporary_proxy_restore_failed", lease=lease.name, error=restore_error)
        if restore_error:
            raise RuntimeError("temporary_proxy_restore_failed")

def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("ensure-termux-background")
    s = sub.add_parser("snapshot")
    s.add_argument("--purpose", default="manual")
    r = sub.add_parser("restore")
    r.add_argument("lease")
    w = sub.add_parser("with-global-proxy")
    w.add_argument("endpoint")
    w.add_argument("--purpose", default="temporary-proxy")
    w.add_argument("command", nargs="+")
    args = ap.parse_args()
    if args.cmd == "check":
        return check_and_reconcile()
    if args.cmd == "ensure-termux-background":
        print(json.dumps(ensure_termux_background_network(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "snapshot":
        print(create_lease(args.purpose))
        return 0
    if args.cmd == "restore":
        lease = Path(args.lease)
        row = json.loads(lease.read_text())
        restore_state(row["settings"])
        lease.unlink(missing_ok=True)
        write_receipt("healthy", "manual_restore_verified")
        return 0
    command = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if not command:
        raise SystemExit("with-global-proxy requires a command")
    return with_global_proxy(args.endpoint, args.purpose, command)

if __name__ == "__main__":
    raise SystemExit(main())
