#!/data/data/com.termux/files/usr/bin/python3
"""Single code root (Amine 02/11/2026): production runs the activated pins, working copies are dev-only.

Playbooks code is read from the pinned snapshot `~/.openclaw/runtime-ui-playbooks/current`
(activate-ui-playbooks.sh), core helpers from the Tier0 release `~/.openclaw/releases/current/termux-lite`.
The mutable copies (`~/.openclaw/workspace/ui-playbooks`, the core checkout) are never a silent deploy.

No rigidity: when the pin is missing the caller falls back to the working copy, keeps running, and leaves a
bounded event file (one per component, throttled). `runtime-sync.sh --check`, run every 30 min by the health
manager, turns a recent event into a named drift, which the health manager already alerts on. No new daemon,
store or scheduler: event files live next to the existing health files and are overwritten in place.

  code_root.py resolve --component C --require REL [--override PATH]...   print the root (exit 3: none); an
                                                                           override is used only if it has REL
  code_root.py event --component C --event E --reason R [--root PATH]     record a fallback/skip (throttled)
  code_root.py baseline --source activation|deploy [--playbooks SHA] [--core SHA]
  code_root.py check [--core-repo PATH] [--window-s N]                    one JSON line {drift, advisory}
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PIN_REL = ".openclaw/runtime-ui-playbooks/current"
WORKSPACE_PLAYBOOKS_REL = ".openclaw/workspace/ui-playbooks"
RELEASE_REL = ".openclaw/releases/current"
STATE_REL = ".openclaw/health/code-root"
COMPONENT_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,47}$")
EVENT_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
THROTTLE_S = 600
MAX_EVENT_FILES = 64
MAX_SKILL_FILES = 4000
DEFAULT_WINDOW_S = 7200


def _home(home: Path | str | None = None) -> Path:
    return Path(home) if home is not None else Path(os.environ.get("HOME") or Path.home())


def pin_root(home=None) -> Path:
    return _home(home) / PIN_REL


def workspace_playbooks(home=None) -> Path:
    return _home(home) / WORKSPACE_PLAYBOOKS_REL


def release_root(home=None) -> Path:
    return _home(home) / RELEASE_REL


def state_dir(home=None) -> Path:
    return _home(home) / STATE_REL


def _now() -> float:
    return dt.datetime.now(dt.timezone.utc).timestamp()


def record_event(component: str, event: str = "fallback", root: Path | str | None = None, reason: str = "pin_missing",
                 home=None, now: float | None = None) -> bool:
    """Leave (or refresh) one small event file; never raises, never blocks the caller."""
    try:
        if not COMPONENT_RE.fullmatch(component) or not EVENT_RE.fullmatch(event):
            return False
        # Observation only: never create the OpenClaw home (a refusal path must stay free of any store).
        if not (_home(home) / ".openclaw").is_dir():
            return False
        events = state_dir(home) / "events"
        target = events / f"{component}.json"
        now = _now() if now is None else now
        if target.exists() and now - target.stat().st_mtime < THROTTLE_S:
            try:
                if json.loads(target.read_text()).get("event") == event:
                    return False
            except (OSError, ValueError):
                pass
        events.mkdir(parents=True, exist_ok=True)
        if not target.exists() and len(list(events.glob("*.json"))) >= MAX_EVENT_FILES:
            return False
        body = {"version": 1, "component": component, "event": event, "reason": str(reason)[:80],
                "root": str(root or "")[:300],
                "at": dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec="seconds")}
        tmp = target.with_name(f".{target.name}.{os.getpid()}")
        tmp.write_text(json.dumps(body, ensure_ascii=False) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
        os.utime(target, (now, now))
        print(f"code_root {event} component={component} reason={body['reason']}", file=sys.stderr)
        return True
    except OSError:
        return False


def ui_playbooks_root(component: str, required: str, overrides=(), home=None) -> Path | None:
    """Explicit overrides that carry `required`, the activated pin, then the working copy with an event."""
    for value in overrides:
        if value and (Path(value).expanduser() / required).is_file():
            return Path(value).expanduser()
    pin = pin_root(home)
    if (pin / required).is_file():
        return pin
    workspace = workspace_playbooks(home)
    if (workspace / required).is_file():
        record_event(component, "fallback", workspace, "pin_missing" if not pin.exists() else "pin_lacks_file", home)
        return workspace
    return None


def skills_digest(home=None) -> dict:
    """Content digest of the agent skills directory (paths + bytes, dot-directories excluded)."""
    workspace = Path(os.environ.get("OPENCLAW_WORKSPACE") or _home(home) / ".openclaw/workspace")
    skills = workspace / "skills"
    if not skills.is_dir():
        return {"sha256": None, "files": 0}
    digest = hashlib.sha256()
    count = 0
    for path in sorted(skills.rglob("*")):
        rel = path.relative_to(skills)
        if any(part.startswith(".") or part == "__pycache__" for part in rel.parts) or not path.is_file():
            continue
        count += 1
        if count > MAX_SKILL_FILES:
            return {"sha256": None, "files": count, "reason": "too_many_files"}
        try:
            data = path.read_bytes()
        except OSError:
            continue
        digest.update(rel.as_posix().encode() + b"\0" + hashlib.sha256(data).hexdigest().encode() + b"\n")
    return {"sha256": digest.hexdigest(), "files": count}


def record_baseline(source: str, playbooks: str = "", core: str = "", home=None) -> dict:
    base = state_dir(home)
    base.mkdir(parents=True, exist_ok=True)
    body = {"version": 1, "source": source, "playbooks": playbooks or None, "core": core or None,
            "skills": skills_digest(home), "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    target = base / "baseline.json"
    tmp = target.with_name(f".baseline.{os.getpid()}")
    tmp.write_text(json.dumps(body, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
    return body


def _git(repo: Path, *args: str) -> str | None:
    try:
        run = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    return run.stdout if run.returncode == 0 else None


def _pin_commit(home=None) -> str | None:
    try:
        name = Path(os.path.realpath(pin_root(home))).name
    except OSError:
        return None
    return name if re.fullmatch(r"[0-9a-f]{40}", name) else None


def check(core_repo: Path | None = None, home=None, window_s: int = DEFAULT_WINDOW_S, jobs: bool = True) -> dict:
    """Changes nothing. drift = production may run code nobody activated; advisory = dev copies only."""
    drift: list[str] = []
    advisory: list[str] = []
    now = _now()
    pin = pin_root(home)
    if not (pin / "skill_intelligence/capability_graph.py").is_file():
        drift.append("code_root:playbooks_pin_missing")
    # 1. Recent fallbacks/skips left by any caller (claw-capability, model-fast-path, Companion, cron helpers…).
    events = state_dir(home) / "events"
    for path in sorted(events.glob("*.json"))[:MAX_EVENT_FILES] if events.is_dir() else []:
        try:
            if now - path.stat().st_mtime > window_s:
                continue
            row = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        component, event = str(row.get("component", "")), str(row.get("event", ""))
        if COMPONENT_RE.fullmatch(component) and EVENT_RE.fullmatch(event):
            drift.append(f"code_root:{component}:{event}")
    # 2. The core checkout still serves the Companion: a dirty tree is a production drift.
    if core_repo is not None and (Path(core_repo) / ".git").exists():
        status = _git(Path(core_repo), "status", "--porcelain", "--untracked-files=no")
        if status is None:
            advisory.append("working_copy:core_unreadable")
        elif status.strip():
            drift.append("working_copy:core_dirty")
    # 3. The playbooks working copy is dev-only: reported, never alerting by itself.
    workspace = workspace_playbooks(home)
    if (workspace / ".git").exists():
        status = _git(workspace, "status", "--porcelain")
        if status is None:
            advisory.append("working_copy:playbooks_unreadable")
        elif status.strip():
            advisory.append("working_copy:playbooks_dirty")
        head = (_git(workspace, "rev-parse", "HEAD") or "").strip()
        pinned = _pin_commit(home)
        if head and pinned and head != pinned:
            advisory.append(f"working_copy:playbooks_head_{head[:8]}_pin_{pinned[:8]}")
    # 4. Agent skills against the last activation/deploy baseline.
    try:
        baseline = json.loads((state_dir(home) / "baseline.json").read_text())
        expected = (baseline.get("skills") or {}).get("sha256")
    except (OSError, ValueError, AttributeError):
        baseline = expected = None
    if not isinstance(baseline, dict):
        advisory.append("skills:no_activation_baseline")
    elif skills_digest(home).get("sha256") != expected:
        drift.append("skills:changed_since_activation")
    # 5. Scheduled jobs still started from a working copy.
    if jobs:
        try:
            import job_code_root
            report = job_code_root.check(home=home)
            drift.extend(report.get("drift", []))
            advisory.extend(report.get("advisory", []))
        except Exception as exc:  # the check must answer even if the cron store is unreadable
            advisory.append("jobs:unreadable_" + type(exc).__name__)
    return {"drift": drift, "advisory": advisory}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("resolve")
    p.add_argument("--component", required=True)
    p.add_argument("--require", required=True)
    p.add_argument("--override", action="append", default=[])
    p = sub.add_parser("event")
    p.add_argument("--component", required=True)
    p.add_argument("--event", default="fallback")
    p.add_argument("--reason", default="pin_missing")
    p.add_argument("--root", default="")
    p = sub.add_parser("baseline")
    p.add_argument("--source", required=True, choices=["activation", "deploy"])
    p.add_argument("--playbooks", default="")
    p.add_argument("--core", default="")
    p = sub.add_parser("check")
    p.add_argument("--core-repo")
    p.add_argument("--window-s", type=int, default=DEFAULT_WINDOW_S)
    p.add_argument("--no-jobs", action="store_true")
    args = parser.parse_args(argv)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    if args.cmd == "resolve":
        root = ui_playbooks_root(args.component, args.require, args.override)
        if root is None:
            return 3
        print(root)
        return 0
    if args.cmd == "event":
        record_event(args.component, args.event, args.root, args.reason)
        return 0
    if args.cmd == "baseline":
        print(json.dumps(record_baseline(args.source, args.playbooks, args.core), ensure_ascii=False))
        return 0
    report = check(Path(args.core_repo) if args.core_repo else None, window_s=args.window_s, jobs=not args.no_jobs)
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
