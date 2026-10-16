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
from pathlib import Path


def openclaw_home() -> Path:
    return Path(os.environ.get("OPENCLAW_HOME", str(Path.home() / ".openclaw")))


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


@contextlib.contextmanager
def deployment_guard(root: Path | None = None):
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
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield fd
    finally:
        os.close(fd)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openclaw-home", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    mode = current_mode(args.openclaw_home)
    print(json.dumps({"mode": mode}) if args.json else mode)
    return 0 if mode == "normal" else 75


if __name__ == "__main__":
    raise SystemExit(main())
