#!/data/data/com.termux/files/usr/bin/python3
"""Close one bounded Android runtime receipt for each device boot.

This is a read-only startup check.  The Health Manager remains the owner of
phantom-headroom reconciliation; this program only records and reports drift.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


TARGET_PHANTOM_PROCESSES = 128
ADB_SERIAL = os.environ.get("CLAW_ADB_SERIAL", "127.0.0.1:5556")
HOME = Path.home()
HEALTH = Path(os.environ.get("CLAW_HEALTH_ROOT", HOME / ".openclaw" / "health"))
RECEIPT = HEALTH / "android-startup.json"
ROOT = Path(os.environ.get("CLAW_RUNTIME_ROOT", Path(__file__).resolve().parent))


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    tmp = Path(raw)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def run_adb(*args: str) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["adb", "-s", ADB_SERIAL, *args],
            text=True,
            capture_output=True,
            timeout=8,
        )
        return proc.returncode, proc.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 124, ""


def boot_id() -> str:
    override = os.environ.get("CLAW_BOOT_ID")
    if override:
        return override[:128]
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()[:128]
    except OSError:
        return "unknown"


def phantom_check(text: str, ok: bool) -> dict:
    values = [int(x) for x in re.findall(r"max_phantom_processes\s*=\s*(\d+)", text)]
    effective = values[0] if values else None
    healthy = ok and effective is not None and effective >= TARGET_PHANTOM_PROCESSES
    return {
        "state": "healthy" if healthy else "attention",
        "effective": effective,
        "minimum": TARGET_PHANTOM_PROCESSES,
        "reason": "within_limit" if healthy else ("probe_failed" if not ok or effective is None else "below_minimum"),
    }


def wakelock_check(text: str, ok: bool) -> dict:
    held = any(
        "wake" in line.lower()
        and "lock" in line.lower()
        and ("com.termux" in line.lower() or "termux" in line.lower())
        and "disabled" not in line.lower()
        for line in text.splitlines()
    )
    return {
        "state": "healthy" if ok and held else "attention",
        "held": bool(ok and held),
        "reason": "held" if ok and held else ("probe_failed" if not ok else "not_held"),
    }


def battery_check(text: str, ok: bool) -> dict:
    packages = set()
    for line in text.splitlines():
        fields = [field.strip().lower() for field in line.split(",")]
        packages.update(field for field in fields if re.fullmatch(r"[a-z0-9_.]+", field))
    exempt = "com.termux" in packages
    return {
        "state": "healthy" if ok and exempt else "attention",
        "package": "com.termux",
        "exempt": bool(ok and exempt),
        "reason": "exempt" if ok and exempt else ("probe_failed" if not ok else "not_exempt"),
    }


def signal_attention(reasons: list[str]) -> None:
    helper = ROOT / "incident-notify.sh"
    if not helper.exists():
        return
    subprocess.run(
        [
            str(helper),
            "warning",
            "Samantha — garde-fous Android à vérifier au démarrage : " + ", ".join(reasons),
            "Vérifier les réglages Android signalés dans le reçu health/android-startup.json.",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="rejouer le contrôle pendant le même boot")
    args = parser.parse_args()
    current_boot = boot_id()
    if RECEIPT.exists() and not args.force:
        try:
            prior = json.loads(RECEIPT.read_text())
            if prior.get("boot_id") == current_boot and prior.get("state") == "closed":
                print(json.dumps(prior, ensure_ascii=False, separators=(",", ":")))
                return 0
        except (OSError, ValueError):
            pass

    started = dt.datetime.now(dt.timezone.utc).isoformat()
    adb_rc, adb_state = run_adb("get-state")
    adb_ready = adb_rc == 0 and adb_state.strip() == "device"
    if adb_ready:
        phantom_rc, phantom_raw = run_adb("shell", "dumpsys", "activity", "settings")
        power_rc, power_raw = run_adb("shell", "dumpsys", "power")
        battery_rc, battery_raw = run_adb("shell", "dumpsys", "deviceidle", "whitelist")
    else:
        phantom_rc = power_rc = battery_rc = 1
        phantom_raw = power_raw = battery_raw = ""
    checks = {
        "adb": {"state": "healthy" if adb_ready else "attention", "reason": "ready" if adb_ready else "unavailable"},
        "phantom_processes": phantom_check(phantom_raw, phantom_rc == 0),
        "termux_wakelock": wakelock_check(power_raw, power_rc == 0),
        "battery_optimization": battery_check(battery_raw, battery_rc == 0),
    }
    reasons = [f"{name}:{value['reason']}" for name, value in checks.items() if value["state"] != "healthy"]
    receipt = {
        "version": 1,
        "kind": "android_startup_guard",
        "state": "closed",
        "verdict": "healthy" if not reasons else "attention",
        "boot_id": current_boot,
        "started_at": started,
        "closed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "checks": checks,
        "attention": reasons,
    }
    atomic_json(RECEIPT, receipt)
    if reasons:
        signal_attention(reasons)
    print(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
