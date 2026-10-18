#!/data/data/com.termux/files/usr/bin/python3
"""Canonical repair mode derived from the existing Tier0 stop and deploy lock.

This module owns no state.  Every repair loop reads the same two existing
owners: ``tier0/emergency-stop.json`` and ``deploys/companion-deploy.lock``.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import stat
import time
from pathlib import Path


def openclaw_home() -> Path:
    return Path(os.environ.get("OPENCLAW_HOME", str(Path.home() / ".openclaw")))


def release_root(home: Path | None = None) -> Path:
    """Tier0 owns the current link; readers must not spell it independently."""
    return Path(home or Path.home()) / ".openclaw" / "releases" / "current"


def runtime_root(fallback: Path | None = None, home: Path | None = None) -> Path:
    """Companion/Gateway helpers follow current, never an inherited daemon pin.

    Preserve the link spelling across promotions and leave the environment
    untouched. Pinned Tier0 daemons keep their existing shell owner in lib.sh.
    An explicitly supplied local fallback retains its existing caller contract.
    """
    return Path(fallback) if fallback is not None else release_root(home) / "termux-lite"



def contract_drift(core: Path, playbooks: Path, app_contract: Path | None = None) -> list[str]:
    """Read static owner contracts only. Never import/execute the inspected source."""
    import ast
    import re
    drift = []
    def constants(path, names):
        tree = ast.parse(path.read_text())
        values = {}
        for item in tree.body:
            if isinstance(item, ast.Assign):
                for target in item.targets:
                    if isinstance(target, ast.Name) and target.id in names:
                        value = ast.literal_eval(item.value)
                        if type(value) is not int or value <= 0 or target.id in values:
                            raise ValueError("invalid_budget")
                        values[target.id] = value
        if set(values) != set(names):
            raise ValueError("missing_budget")
        return values
    try:
        owner = constants(playbooks / "skill_intelligence/public_web.py", {"BUDGET_MS", "SEARCH_BUDGET_MS"})
        if owner["SEARCH_BUDGET_MS"] > owner["BUDGET_MS"]:
            drift.append("budget:web_owner_invalid")
        runner = constants(core / "installer/termux-lite/model-fast-path.py", {"PUBLIC_WEB_BUDGET_MS"})
        source = (core / "openclaw-plugin-mobile-ui/src/companion/runWeb.ts").read_text()
        copies = re.findall(r"export const PUBLIC_WEB_BUDGET_MS\s*=\s*([0-9_]+)\s*;", source)
        if len(copies) != 1 or int(copies[0].replace("_", "")) != owner["BUDGET_MS"]:
            drift.append("budget:web_companion")
        if runner["PUBLIC_WEB_BUDGET_MS"] != owner["BUDGET_MS"]:
            drift.append("budget:web_fast_path")
    except (OSError, ValueError, SyntaxError, TypeError):
        drift.append("budget:web_contract_unavailable")
    try:
        original = (core / "openclaw-plugin-mobile-ui/fixtures/protocol/voice-v2-app-companion.json").read_bytes()
        contract = json.loads(original)
        correlation = contract.get("correlation")
        if contract.get("version") != 2 or not isinstance(correlation, dict) or not isinstance(correlation.get("values"), list) or not correlation["values"] or any(not isinstance(v, str) or not v for v in correlation["values"]) or len(set(correlation["values"])) != len(correlation["values"]) or correlation.get("unknown") != "fatal":
            drift.append("voice:correlation_contract")
    except (OSError, ValueError, AttributeError):
        drift.append("voice:runtime_contract_unavailable")
    else:
        if app_contract is not None:
            try:
                if original != app_contract.read_bytes():
                    drift.append("voice:app_contract_differs")
            except OSError:
                drift.append("voice:app_contract_unavailable")
    return drift


def _stop_state(root: Path) -> str | None:
    path = root / "tier0" / "emergency-stop.json"
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        return "unknown"
    if path.is_symlink() or not stat.S_ISREG(info.st_mode):
        return "unknown"
    try:
        row = json.loads(path.read_text())
    except (OSError, ValueError):
        return "unknown"
    return "emergency_stop" if isinstance(row, dict) and row.get("enabled") is True else "unknown"


def current_mode(root: Path | None = None) -> str:
    root = Path(root or openclaw_home())
    stopped = _stop_state(root)
    if stopped:
        return stopped
    path = root / "deploys" / "companion-deploy.lock"
    try:
        info = path.lstat()
    except FileNotFoundError:
        return "normal"
    except OSError:
        return "unknown"
    if path.is_symlink() or not stat.S_ISREG(info.st_mode):
        return "unknown"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
            return "normal"
        except BlockingIOError:
            return "deployment"
        finally:
            os.close(fd)
    except OSError:
        return "unknown"


def _inherited_lock_fd(path: Path) -> int | None:
    raw = os.environ.get("SAMANTHA_DEPLOY_LOCK_FD", "")
    if not raw.isdigit():
        return None
    fd = int(raw)
    try:
        opened = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            same = os.fstat(fd).st_dev == os.fstat(opened).st_dev and os.fstat(fd).st_ino == os.fstat(opened).st_ino
        finally:
            os.close(opened)
        if not same:
            return None
        # The inherited open-file description already owns the exclusive flock.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (OSError, BlockingIOError):
        return None


class DeploymentLockBusy(OSError):
    """The deployment lock is held elsewhere and was not inherited (bounded wait elapsed)."""


@contextlib.contextmanager
def deployment_guard(root: Path | None = None, wait_seconds: float | None = None):
    """Hold the existing deployment lock, reusing a verified inherited fd."""
    root = Path(root or openclaw_home())
    path = root / "deploys" / "companion-deploy.lock"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    inherited = _inherited_lock_fd(path) if path.exists() else None
    if inherited is not None:
        yield inherited
        return
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("deployment_lock_invalid")
        # Bounded, never an infinite wait: a parent deploy that holds the lock without exporting
        # SAMANTHA_DEPLOY_LOCK_FD (older companion-deploy.sh, bascule 17/10) would otherwise deadlock its child.
        if wait_seconds is None:
            raw = os.environ.get("SAMANTHA_DEPLOY_LOCK_WAIT_S", "30")
            wait_seconds = float(raw) if raw.replace(".", "", 1).isdigit() else 30.0
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise DeploymentLockBusy(
                        "deployment_lock_busy: companion-deploy.lock is held by another process and "
                        "SAMANTHA_DEPLOY_LOCK_FD does not name an inherited holder; if a parent deploy "
                        "started this command, it must export SAMANTHA_DEPLOY_LOCK_FD") from None
                time.sleep(0.2)
        yield fd
    finally:
        os.close(fd)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openclaw-home", type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--check-runtime-parity", nargs=2, type=Path, metavar=("CORE", "PLAYBOOKS"))
    parser.add_argument("--check-parity", nargs=3, type=Path, metavar=("CORE", "PLAYBOOKS", "APP_CONTRACT"))
    args = parser.parse_args(argv)
    if args.check_parity or args.check_runtime_parity:
        drift = contract_drift(*(args.check_parity or args.check_runtime_parity))
        print(json.dumps({"ok": not drift, "drift": drift}))
        return 1 if drift else 0
    mode = current_mode(args.openclaw_home)
    print(json.dumps({"mode": mode}) if args.json else mode)
    return 0 if mode == "normal" else 75


if __name__ == "__main__":
    raise SystemExit(main())
