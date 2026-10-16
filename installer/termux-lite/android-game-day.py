#!/data/data/com.termux/files/usr/bin/python3
"""Run the bounded monthly Android resilience exercise under existing owners."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path


HOME = Path.home()
ROOT = Path(os.environ.get("CLAW_RUNTIME_ROOT", Path(__file__).resolve().parent))
HEALTH = Path(os.environ.get("CLAW_HEALTH_ROOT", HOME / ".openclaw" / "health"))
RECEIPT = HEALTH / "android-game-day.json"
LOCK = HEALTH / "android-game-day.lock"
DEPLOY_LOCK = HOME / ".openclaw" / "deploys" / "companion-deploy.lock"


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


def deploy_active() -> bool:
    DEPLOY_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with DEPLOY_LOCK.open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle, fcntl.LOCK_UN)
            return False
        except BlockingIOError:
            return True


def run(command: list[str], timeout: int) -> dict:
    started = time.monotonic()
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
        return {
            "ok": result.returncode == 0,
            "returncode": result.returncode,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "detail": (result.stderr or result.stdout).strip()[:500],
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "returncode": 124, "duration_ms": int((time.monotonic() - started) * 1000), "detail": "timeout"}


def phase_commands(window: int) -> list[tuple[str, list[str], list[str], bool]]:
    sleep = os.environ.get("CLAW_GAME_DAY_SLEEP", "sleep")
    return [
        (
            "gateway_kill_9",
            ["pkill", "-KILL", "-f", "[o]penclaw.*gateway"],
            ["curl", "-fsS", "--max-time", "10", "http://127.0.0.1:18789/healthz"],
            True,
        ),
        (
            "network_cut",
            [str(ROOT / "android-network-mutation-guard.py"), "with-global-proxy", "127.0.0.1:9", "--purpose", "i10-monthly-game-day", sleep, str(window)],
            ["curl", "-fsS", "--max-time", "10", "http://127.0.0.1:18789/healthz"],
            False,
        ),
        (
            "adb_loss",
            ["adb", "disconnect", os.environ.get("CLAW_ADB_SERIAL", "127.0.0.1:5556")],
            ["adb", "-s", os.environ.get("CLAW_ADB_SERIAL", "127.0.0.1:5556"), "get-state"],
            True,
        ),
    ]


def write_learning_gate(run_id: str, results: list[dict]) -> dict:
    failures = [row["name"] for row in results if not row["recovered"]]
    payload = {
        "symptom": "monthly Android resilience game day",
        "root_cause": "exercise failure" if failures else "controlled failure injection",
        "failed_attempts": failures,
        "final_fix": "existing recovery owners restored all exercised dependencies" if not failures else "manual review required",
        "reusable_learning": "Review the monthly recovery timings and any failed phase before changing an owner.",
        "regression_guard": "I10 monthly 30-minute game day",
        "how_to": ["Use the existing Gateway, network guard and ADB recovery owners."],
        "evidence": [f"health/android-game-day.json#{run_id}"],
        "confidence": "validated" if not failures else "provisional",
    }
    HEALTH.mkdir(parents=True, exist_ok=True)
    learning = HEALTH / f".android-game-day-learning-{os.getpid()}.json"
    atomic_json(learning, payload)
    try:
        result = run(
            [
                str(ROOT / "learning-gate-close.sh"), "--source", "game_day",
                "--closure-id", run_id, "--component", "android_runtime",
                "--status", "recovered" if not failures else "failed",
                "--summary", "I10 monthly Android resilience exercise",
                "--learning-file", str(learning),
            ],
            20,
        )
    finally:
        learning.unlink(missing_ok=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--duration-seconds", type=int, default=1800)
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()
    if not args.execute:
        raise SystemExit("refused_without_execute")
    if not 30 <= args.duration_seconds <= 1800:
        raise SystemExit("duration_out_of_bounds")
    if deploy_active():
        raise SystemExit("deployment_in_progress")

    HEALTH.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("game_day_already_running")
        run_id = args.run_id or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
        started = dt.datetime.now(dt.timezone.utc).isoformat()
        window = args.duration_seconds // 3
        results = []
        sleep = os.environ.get("CLAW_GAME_DAY_SLEEP", "sleep")
        for name, inject, verify, needs_wait in phase_commands(window):
            injected = run(inject, window + 30)
            waited = run([sleep, str(window)], window + 30) if needs_wait else {"ok": True, "returncode": 0, "duration_ms": 0, "detail": "covered_by_guarded_injection"}
            verified = run(verify, window + 30)
            if name == "adb_loss" and verified["ok"]:
                verified["ok"] = verified["detail"].strip() == "device"
            recovered = injected["ok"] and waited["ok"] and verified["ok"]
            results.append({"name": name, "injection": injected, "wait": waited, "verification": verified, "recovered": recovered})
        receipt = {
            "version": 1,
            "kind": "android_resilience_game_day",
            "state": "closed",
            "run_id": run_id,
            "duration_budget_seconds": args.duration_seconds,
            "started_at": started,
            "closed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "result": "passed" if all(row["recovered"] for row in results) else "attention",
            "phases": results,
        }
        atomic_json(RECEIPT, receipt)
        receipt["learning_gate"] = write_learning_gate(run_id, results)
        atomic_json(RECEIPT, receipt)
        print(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")))
        return 0 if receipt["result"] == "passed" and receipt["learning_gate"]["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
