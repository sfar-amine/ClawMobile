#!/usr/bin/env python3
"""Nightly dialogue replay hook (Amine 28/10, recommendation 3).

Runs `skill_intelligence.dialogue.replay` from the active playbooks snapshot: recorded owner requests replayed on a
private dialogue store, no write possible, plus the technical-failure causes of the last 24 h that have no named
reply. Called by companion-nightly-acceptance.py inside its own lock and receipt; no job, store or notifier here.
"""
import re
import sys
from pathlib import Path

REPLAY_TIMEOUT_SECONDS = 300
RUN = ("import os,runpy,sys;root=sys.argv[1];os.chdir(root);sys.path.insert(0,root);sys.argv=[root];"
       "runpy.run_module('skill_intelligence.dialogue.replay',run_name='__main__')")
CASE = re.compile(r"[a-z0-9-]{1,80}")
CAUSE = re.compile(r"[A-Za-z0-9_]{1,64}")


def playbooks_root(home):
    current = Path(home) / ".openclaw/runtime-ui-playbooks/current"
    root = current.resolve() if current.is_symlink() or current.is_dir() else None
    return root if root and (root / "skill_intelligence/dialogue/replay.py").is_file() else None


def closed_report(raw):
    if not isinstance(raw, dict) or raw.get("state") not in ("passed", "attention", "failed"):
        raise ValueError("invalid_replay_report")
    cases, failed, causes = raw.get("cases"), raw.get("failed"), raw.get("unnamedFailures")
    if not isinstance(cases, int) or isinstance(cases, bool) or not 0 <= cases <= 5000:
        raise ValueError("invalid_replay_cases")
    if not isinstance(failed, list) or len(failed) > 50 or not all(isinstance(c, str) and CASE.fullmatch(c) for c in failed):
        raise ValueError("invalid_replay_failed")
    if not isinstance(causes, list) or len(causes) > 50 or not all(isinstance(c, str) and CAUSE.fullmatch(c) for c in causes):
        raise ValueError("invalid_replay_causes")
    out = {"state": raw["state"], "cases": cases, "failed": failed, "unnamedFailures": causes}
    seconds = raw.get("seconds")
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and 0 <= seconds <= REPLAY_TIMEOUT_SECONDS:
        out["seconds"] = seconds
    return out


def execute_replay(home, runner):
    """(receipt section, attention, failed). No active snapshot carrying the replay: not configured, no verdict."""
    root = playbooks_root(home)
    if root is None:
        return {"state": "not_configured"}, False, False
    try:
        code, raw = runner([sys.executable, "-c", RUN, str(root)], REPLAY_TIMEOUT_SECONDS)
        report = closed_report(raw)
    except (OSError, ValueError, TimeoutError):
        return {"state": "unavailable", "reason": "replay_unavailable", "revision": root.name[:40]}, True, False
    report["revision"] = root.name[:40]
    failed = code != 0 or report["state"] == "failed"
    return report, report["state"] == "attention", failed
