#!/data/data/com.termux/files/usr/bin/python3
import argparse
import json
import os
import subprocess
import time
from pathlib import Path

HOME = Path.home()
OC = HOME / ".openclaw"
STATE_DIR = OC / "watchdogs"
HEALTH_DIR = OC / "health"
CANONICAL = os.environ.get("ADB_RECOVERY_CANONICAL", "127.0.0.1:5556")
DISCOVER = HOME / "ClawMobile/installer/termux-lite/adb-discover-endpoint.py"
RECEIPT = HEALTH_DIR / "adb-recovery-readiness.json"
EXPECTED = STATE_DIR / "adb-expected-serial"
LAST_ENDPOINT = STATE_DIR / "adb-last-endpoint"

def run_cmd(args, timeout=4):
    try:
        p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except Exception as exc:
        return 124, "", type(exc).__name__

def adb_out(*args, timeout=4):
    rc, out, _ = run_cmd(["adb", "-s", CANONICAL, *args], timeout=timeout)
    return out if rc == 0 else ""

def expected_serial():
    try:
        return EXPECTED.read_text().strip()
    except OSError:
        return ""

def canonical_status():
    state = adb_out("get-state", timeout=3)
    serial = adb_out("shell", "getprop", "ro.serialno", timeout=3)
    expected = expected_serial()
    verified = state == "device" and bool(serial) and (not expected or serial == expected)
    return state, serial, verified

def wireless_setting():
    value = adb_out("shell", "settings", "get", "global", "adb_wifi_enabled", timeout=3).strip()
    return value if value in {"0", "1"} else None

def wifi_enabled():
    value = adb_out("shell", "cmd", "wifi", "status", timeout=3).lower()
    if "wifi is enabled" in value:
        return True
    if "wifi is disabled" in value:
        return False
    return None

def discover_endpoints(expected, timeout_s):
    if not expected or not DISCOVER.exists():
        return []
    rc, out, _ = run_cmd(
        [str(DISCOVER), "--serial", expected, "--timeout", str(timeout_s)],
        timeout=max(2, int(timeout_s) + 2),
    )
    if rc != 0:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]

def verify_endpoint(endpoint, expected):
    run_cmd(["adb", "connect", endpoint], timeout=4)
    rc, state, _ = run_cmd(["adb", "-s", endpoint, "get-state"], timeout=3)
    if rc != 0 or state.strip() != "device":
        return False
    rc, serial, _ = run_cmd(["adb", "-s", endpoint, "shell", "getprop", "ro.serialno"], timeout=4)
    return rc == 0 and bool(expected) and serial.strip() == expected

def write_receipt(row):
    HEALTH_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RECEIPT.with_suffix(".tmp")
    tmp.write_text(json.dumps(row, sort_keys=True, indent=2) + "\n")
    os.replace(tmp, RECEIPT)

def probe(discover_timeout=2.0, persist=True):
    checked = int(time.time())
    state, serial, canonical_verified = canonical_status()
    try:
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        boot_id = None
    base = {
        "schema_version": 1,
        "checked_at": checked,
        "boot_id": boot_id,
        "canonical_endpoint": CANONICAL,
        "canonical_state": state or "unavailable",
        "canonical_identity_verified": canonical_verified,
        "wireless_setting": None,
        "wifi_enabled": None,
        "endpoint_discovered": False,
        "endpoint_verified": False,
        "requires_owner_action": False,
    }
    if not canonical_verified:
        row = {**base, "state": "unverified", "reason": "canonical_adb_unavailable"}
        if persist:
            write_receipt(row)
        return row

    wifi = wifi_enabled()
    setting = wireless_setting()
    base["wifi_enabled"] = wifi
    base["wireless_setting"] = setting
    if setting == "0":
        row = {
            **base,
            "state": "standby",
            "reason": (
                "wifi_disabled_recovery_standby"
                if wifi is False
                else "wireless_debugging_disabled_primary_healthy"
            ),
            "requires_owner_action": False,
        }
        if persist:
            write_receipt(row)
        return row

    expected = expected_serial()
    endpoints = discover_endpoints(expected, discover_timeout)
    base["endpoint_discovered"] = bool(endpoints)
    for endpoint in endpoints:
        if verify_endpoint(endpoint, expected):
            base["endpoint_verified"] = True
            if persist:
                STATE_DIR.mkdir(parents=True, exist_ok=True)
                LAST_ENDPOINT.write_text(endpoint)
            row = {**base, "state": "ready", "reason": "trusted_wireless_endpoint_verified"}
            if persist:
                write_receipt(row)
            return row

    if setting == "1":
        row = {
            **base,
            "state": "standby",
            "reason": "wireless_endpoint_not_discoverable_primary_healthy",
            "requires_owner_action": False,
        }
    else:
        row = {**base, "state": "unverified", "reason": "wireless_state_unobservable"}
    if persist:
        write_receipt(row)
    return row

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--discover-timeout", type=float, default=2.0)
    args = ap.parse_args()
    row = probe(args.discover_timeout, persist=not args.no_write)
    if args.json:
        print(json.dumps(row, sort_keys=True))
    raise SystemExit(0 if row["state"] in {"ready", "standby"} else 2)

if __name__ == "__main__":
    main()
