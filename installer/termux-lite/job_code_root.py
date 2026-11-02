#!/data/data/com.termux/files/usr/bin/python3
"""Move the scheduled jobs that still start from a working copy onto the activated pins (Amine 02/11/2026).

S24 02/11 (cron_jobs, fixture s24-2026-11-02-job-code-root): Agenda Sync, « Point personnel des taches » and the
17:00 report ran in `~/.openclaw/workspace/ui-playbooks` (detached, 13 days stale); Context Compactor, Context
Guardian and the memory curator ran the core checkout's scripts. Engineering Maintenance already ran the pin.

  job_code_root.py --check      read-only (cron store opened mode=ro), one JSON line {drift, advisory, jobs}
  job_code_root.py --apply      idempotent: only argv/cwd of the managed jobs change, through `openclaw cron edit`,
                                each one read back; the first original payload is kept for --rollback
  job_code_root.py --rollback   put back the saved argv/cwd of every migrated job

Never blocking: a job whose target is missing in the pin, or that is running, is left as it is and reported;
the next activation (activate-ui-playbooks.sh) or deploy (runtime-sync.sh) retries. The OpenClaw scheduler
stays the only owner of the jobs; nothing else is scheduled here.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

# Playbooks jobs: cwd and argv move from the workspace checkout to the activated snapshot (symlink spelling kept,
# so every activation and rollback is followed without editing the job again).
PLAYBOOKS_JOBS = {
    "samantha:agenda:sync-v2": "agenda/sync_runtime.py",
    "samantha:immune:daily-1700": "reporting/immune_daily.py",
    "samantha:todos:daily-1000": "tools/todos_daily.py",
}
# Core jobs: the script moves from the checkout to the Tier0 release (`clawmobile_release_root`).
CORE_JOBS = {
    "samantha:context-compactor": "context-compact.sh",
    "samantha:context-guardian": "context-guardian.sh",
    "claw:cross-surface-memory-curator": "context-dream.sh",
}
# Known exceptions, reported as advisories, never edited by this lot.
EXCEPTIONS = {
    "samantha:nightly-acceptance": "acceptance_of_the_deployed_checkout",
}
PATH_END = r"(?=$|[/\s\"';&|)])"
PREFIX = r"(?P<pre>\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|~|/[^\s\"';&|$]*?)"
WORKSPACE_RE = re.compile(PREFIX + r"/\.openclaw/workspace/ui-playbooks" + PATH_END)
CHECKOUT_RE = re.compile(PREFIX + r"/ClawMobile/(?:installer|openclaw-plugin-mobile-ui)\b")
CORE_SCRIPT_RE = PREFIX + r"/ClawMobile/installer/termux-lite/(?P<script>%s)" + PATH_END
STABLE_KEYS = ("id", "name", "declarationKey", "enabled", "schedule", "sessionTarget", "wakeMode", "delivery")


def home_dir(home=None) -> Path:
    return Path(home) if home is not None else Path(os.environ.get("HOME") or Path.home())


def state_db(home=None) -> Path:
    return Path(os.environ.get("OPENCLAW_STATE_DIR") or home_dir(home) / ".openclaw") / "state/openclaw.sqlite"


def backup_dir(home=None) -> Path:
    return home_dir(home) / ".openclaw/backups/job-code-root"


def _payload(job: dict) -> dict:
    payload = job.get("payload")
    return payload if isinstance(payload, dict) else {}


def references_working_copy(job: dict) -> bool:
    payload = _payload(job)
    values = [payload.get("cwd") or ""] + [a for a in payload.get("argv") or [] if isinstance(a, str)]
    return any(WORKSPACE_RE.search(v) or CHECKOUT_RE.search(v) for v in values)


def plan(job: dict, home=None) -> dict | None:
    """Wanted {argv, cwd, required} for a managed job still on a working copy, else None."""
    key = job.get("declarationKey")
    payload = _payload(job)
    if payload.get("kind") != "command" or not isinstance(payload.get("argv"), list):
        return None
    argv, cwd = list(payload["argv"]), payload.get("cwd")
    if key in PLAYBOOKS_JOBS:
        swap = lambda v: WORKSPACE_RE.sub(lambda m: m.group("pre") + "/.openclaw/runtime-ui-playbooks/current", v)
        required = home_dir(home) / ".openclaw/runtime-ui-playbooks/current" / PLAYBOOKS_JOBS[key]
    elif key in CORE_JOBS:
        rx = re.compile(CORE_SCRIPT_RE % re.escape(CORE_JOBS[key]))
        swap = lambda v: rx.sub(lambda m: m.group("pre") + "/.openclaw/releases/current/termux-lite/" + m.group("script"), v)
        required = home_dir(home) / ".openclaw/releases/current/termux-lite" / CORE_JOBS[key]
    else:
        return None
    new_argv = [swap(a) if isinstance(a, str) else a for a in argv]
    new_cwd = swap(cwd) if isinstance(cwd, str) else cwd
    if new_argv == argv and new_cwd == cwd:
        return None
    return {"argv": new_argv, "cwd": new_cwd, "required": str(required)}


def load_store(home=None) -> list[dict] | None:
    """Jobs from the OpenClaw cron store, read-only; None when the store is absent."""
    db = state_db(home)
    if not db.is_file():
        return None
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
    try:
        rows = conn.execute("select job_json, enabled from cron_jobs").fetchall()
    finally:
        conn.close()
    jobs = []
    for raw, enabled in rows:
        try:
            job = json.loads(raw)
        except ValueError:
            continue
        if isinstance(job, dict):
            job["enabled"] = bool(enabled)
            jobs.append(job)
    return jobs


def check(home=None, jobs: list[dict] | None = None) -> dict:
    jobs = load_store(home) if jobs is None else jobs
    drift, advisory, rows = [], [], []
    for job in jobs or []:
        if not job.get("enabled") or _payload(job).get("kind") != "command":
            continue
        key = str(job.get("declarationKey") or job.get("id") or "")
        if plan(job, home):
            drift.append(f"job_root:{key}")
            rows.append({"key": key, "state": "on_working_copy"})
        elif key in EXCEPTIONS and references_working_copy(job):
            advisory.append(f"job_root_exception:{key}")
        elif references_working_copy(job) and key not in PLAYBOOKS_JOBS and key not in CORE_JOBS:
            advisory.append(f"job_root_unmanaged:{key}")
    return {"drift": drift, "advisory": advisory, "jobs": rows}


def cron(*args: str, timeout: int = 45) -> dict:
    run = subprocess.run(["openclaw", "cron", *args, "--json"], capture_output=True, text=True, timeout=timeout)
    if run.returncode:
        raise RuntimeError("native_scheduler_operation_failed:" + args[0])
    return json.loads(run.stdout or "{}")


def _by_key(listing: dict) -> dict:
    out: dict = {}
    for job in listing.get("jobs") or []:
        if isinstance(job, dict) and job.get("declarationKey"):
            out.setdefault(job["declarationKey"], []).append(job)
    return out


def _edit(job_id: str, argv: list, cwd, call) -> None:
    args = ["edit", job_id, "--command-argv", json.dumps(argv, ensure_ascii=False)]
    if isinstance(cwd, str) and cwd:
        args += ["--command-cwd", cwd]
    call(*args)


def _stable(job: dict) -> dict:
    payload = {k: v for k, v in _payload(job).items() if k not in ("argv", "cwd")}
    return {**{k: job.get(k) for k in STABLE_KEYS}, "payload": payload}


def _safe(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", key)[:96]


def _locked(home):
    folder = backup_dir(home)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = (folder / ".lock").open("a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def _write(path: Path, value: dict) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def apply(home=None, call=cron, store: list[dict] | None = None) -> dict:
    store = load_store(home) if store is None else store
    if store is not None and not any(plan(job, home) for job in store if job.get("enabled")):
        return {"state": "unchanged", "jobs": []}
    lock = _locked(home)
    if lock is None:
        return {"state": "busy", "jobs": []}
    try:
        before = _by_key(call("list", "--all"))
        results, edited = [], {}
        for key in list(PLAYBOOKS_JOBS) + list(CORE_JOBS):
            matches = before.get(key, [])
            if len(matches) != 1:
                if matches:
                    results.append({"key": key, "state": "skipped", "reason": "job_identity_not_unique"})
                continue
            job = matches[0]
            wanted = plan(job, home)
            if not job.get("enabled") or wanted is None:
                continue
            if (job.get("state") or {}).get("runningAtMs"):
                results.append({"key": key, "state": "skipped", "reason": "job_running"}); continue
            if not Path(wanted["required"]).is_file():
                results.append({"key": key, "state": "skipped", "reason": "pin_lacks_target"}); continue
            saved = backup_dir(home) / f"{_safe(key)}.json"
            if not saved.exists():
                _write(saved, {"version": 1, "declarationKey": key, "id": job["id"],
                               "argv": _payload(job)["argv"], "cwd": _payload(job).get("cwd")})
            try:
                _edit(job["id"], wanted["argv"], wanted["cwd"], call)
            except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
                results.append({"key": key, "state": "failed", "reason": str(exc)[:80]}); continue
            edited[key] = (job, wanted)
        after = _by_key(call("list", "--all")) if edited else {}
        for key, (job, wanted) in edited.items():
            now = (after.get(key) or [None])[0]
            ok = (now is not None and _payload(now).get("argv") == wanted["argv"]
                  and _payload(now).get("cwd") == wanted["cwd"] and _stable(now) == _stable(job))
            if ok:
                results.append({"key": key, "state": "migrated"}); continue
            try:  # put the reviewed original back; the job keeps running from where it ran before
                _edit(job["id"], _payload(job)["argv"], _payload(job).get("cwd"), call)
                results.append({"key": key, "state": "failed", "reason": "readback_mismatch_restored"})
            except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
                results.append({"key": key, "state": "failed", "reason": "readback_mismatch_restore_failed"})
        failed = any(r["state"] == "failed" for r in results)
        skipped = any(r["state"] == "skipped" for r in results)
        state = "attention_required" if failed else ("partial" if skipped else ("migrated" if edited else "unchanged"))
        receipt = {"version": 1, "state": state, "jobs": results}
        _write(backup_dir(home) / "last.json", receipt)
        return receipt
    finally:
        lock.close()


def rollback(home=None, call=cron) -> dict:
    lock = _locked(home)
    if lock is None:
        return {"state": "busy", "jobs": []}
    try:
        current = _by_key(call("list", "--all"))
        results = []
        for saved in sorted(backup_dir(home).glob("*.json")):
            if saved.name == "last.json":
                continue
            try:
                row = json.loads(saved.read_text())
            except (OSError, ValueError):
                continue
            matches = current.get(row.get("declarationKey"), [])
            if len(matches) != 1 or not isinstance(row.get("argv"), list):
                results.append({"key": row.get("declarationKey"), "state": "skipped", "reason": "job_identity_not_unique"})
                continue
            payload = _payload(matches[0])
            if payload.get("argv") == row["argv"] and payload.get("cwd") == row.get("cwd"):
                results.append({"key": row["declarationKey"], "state": "unchanged"}); continue
            _edit(matches[0]["id"], row["argv"], row.get("cwd"), call)
            results.append({"key": row["declarationKey"], "state": "restored"})
        receipt = {"version": 1, "state": "rolled_back", "jobs": results}
        _write(backup_dir(home) / "last.json", receipt)
        return receipt
    finally:
        lock.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--rollback", action="store_true")
    args = parser.parse_args(argv)
    try:
        out = check() if args.check else apply() if args.apply else rollback()
    except (RuntimeError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as exc:
        print(json.dumps({"state": "attention_required", "reason": type(exc).__name__}))
        return 1
    print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return 1 if out.get("state") == "attention_required" else 0


if __name__ == "__main__":
    sys.exit(main())
