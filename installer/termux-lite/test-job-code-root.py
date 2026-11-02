#!/usr/bin/env python3
"""Job migration to the activated pins, on the S24 cron store captured 02/11/2026
(openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-job-code-root)."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import job_code_root as jcr  # noqa: E402

FIXTURE = HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-job-code-root"
S24_HOME = "/data/data/com.termux/files/home"
MIGRATED = {
    "samantha:agenda:sync-v2": ([f"{S24_HOME}/.openclaw/agenda/google-venv/bin/python", "-m", "agenda.sync_runtime", "tick"],
                                f"{S24_HOME}/.openclaw/runtime-ui-playbooks/current"),
    "samantha:immune:daily-1700": (["python3", "-m", "reporting.immune_daily", "send"], f"{S24_HOME}/.openclaw/runtime-ui-playbooks/current"),
    "samantha:todos:daily-1000": (["sh", "-lc", "cd $HOME/.openclaw/runtime-ui-playbooks/current && python3 tools/todos_daily.py --send"], None),
    "samantha:context-compactor": (["sh", "-lc", "$HOME/.openclaw/releases/current/termux-lite/context-compact.sh"], None),
    "samantha:context-guardian": (["sh", "-lc", "$HOME/.openclaw/releases/current/termux-lite/context-guardian.sh"], None),
    "claw:cross-surface-memory-curator": (["sh", "-lc", f"{S24_HOME}/.openclaw/releases/current/termux-lite/context-dream.sh"], None),
}


class FakeCron:
    """`openclaw cron list --all --json` / `edit <id> --command-argv … [--command-cwd …]` over the fixture jobs."""

    def __init__(self, jobs, break_readback=None):
        self.jobs = {j["id"]: j for j in copy.deepcopy(jobs)}
        self.edits = []
        self.break_readback = break_readback

    def __call__(self, *args):
        if args[0] == "list":
            return {"jobs": copy.deepcopy(list(self.jobs.values()))}
        assert args[0] == "edit" and args[2] == "--command-argv", args
        job = self.jobs[args[1]]
        job["payload"]["argv"] = json.loads(args[3])
        if "--command-cwd" in args:
            job["payload"]["cwd"] = args[args.index("--command-cwd") + 1]
        if self.break_readback == job.get("declarationKey") and len([e for e in self.edits if e[1] == args[1]]) == 0:
            job["payload"]["timeoutSeconds"] = 1  # the scheduler changed something else: must be refused
        self.edits.append(args)
        return {"ok": True}


class JobCodeRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.tmp)
        self.home = self.tmp / "home"
        self.jobs = [{k: v for k, v in row.items() if k != "_columns"} for row in json.loads((FIXTURE / "cron-jobs.json").read_text())]
        pin = self.home / ".openclaw/runtime-ui-playbooks/current"
        for rel in jcr.PLAYBOOKS_JOBS.values():
            (pin / rel).parent.mkdir(parents=True, exist_ok=True); (pin / rel).write_text("")
        release = self.home / ".openclaw/releases/current/termux-lite"; release.mkdir(parents=True)
        for name in jcr.CORE_JOBS.values():
            (release / name).write_text("")

    def store(self, jobs=None):
        db = self.home / ".openclaw/state/openclaw.sqlite"; db.parent.mkdir(parents=True, exist_ok=True)
        if db.exists():
            db.unlink()
        conn = sqlite3.connect(db)
        conn.executescript((FIXTURE / "cron-jobs.schema.sql").read_text())
        for row in json.loads((FIXTURE / "cron-jobs.json").read_text()) if jobs is None else jobs:
            cols = row.get("_columns") or {"payload_kind": row["payload"]["kind"], "declaration_key": row.get("declarationKey"), "enabled": int(row["enabled"])}
            job = {k: v for k, v in row.items() if k != "_columns"}
            conn.execute("insert into cron_jobs(store_key,job_id,declaration_key,name,enabled,payload_kind,job_json,updated_at) values(?,?,?,?,?,?,?,0)",
                         ("default", job["id"], cols["declaration_key"], job["name"], cols["enabled"], cols["payload_kind"], json.dumps(job)))
        conn.commit(); conn.close()

    def by_key(self, cron):
        return {j.get("declarationKey"): j for j in cron.jobs.values()}

    def test_check_on_the_s24_store_names_the_six_jobs_and_the_exception(self):
        self.store()
        report = jcr.check(home=self.home)
        self.assertEqual(sorted(report["drift"]), sorted(f"job_root:{k}" for k in MIGRATED))
        self.assertEqual(report["advisory"], ["job_root_exception:samantha:nightly-acceptance"])
        self.assertNotIn("job_root:samantha:engineering-maintenance", report["drift"], "already on the pin")
        self.assertNotIn("job_root:samantha:slack-control-purge", report["drift"], "disabled jobs are left alone")

    def test_apply_moves_only_argv_and_cwd_then_is_idempotent(self):
        self.store()
        cron = FakeCron(self.jobs)
        before = self.by_key(cron)
        out = jcr.apply(home=self.home, call=cron)
        self.assertEqual(out["state"], "migrated")
        self.assertEqual(sorted(r["key"] for r in out["jobs"] if r["state"] == "migrated"), sorted(MIGRATED))
        after = self.by_key(cron)
        for key, (argv, cwd) in MIGRATED.items():
            self.assertEqual(after[key]["payload"]["argv"], argv, key)
            self.assertEqual(after[key]["payload"].get("cwd"), cwd, key)
            self.assertEqual(jcr._stable(after[key]), jcr._stable(before[key]), key)
        for key in ("samantha:nightly-acceptance", "samantha:engineering-maintenance", "samantha:slack-control-purge", "heartbeat:main"):
            self.assertEqual(after[key], before[key], key)
        saved = json.loads((jcr.backup_dir(self.home) / "samantha_agenda_sync-v2.json").read_text())
        self.assertEqual(saved["cwd"], f"{S24_HOME}/.openclaw/workspace/ui-playbooks")
        self.assertEqual(jcr.check(home=self.home, jobs=list(cron.jobs.values()))["drift"], [])
        edits = len(cron.edits)
        self.assertEqual(jcr.apply(home=self.home, call=cron)["state"], "unchanged")
        self.assertEqual(len(cron.edits), edits, "a second run edits nothing")
        # Rollback puts every original argv/cwd back; the backup keeps the first original.
        self.assertEqual(jcr.rollback(home=self.home, call=cron)["state"], "rolled_back")
        self.assertEqual(self.by_key(cron), before)

    def test_store_without_work_never_calls_the_scheduler(self):
        migrated = copy.deepcopy(self.jobs)
        for job in migrated:
            if job.get("declarationKey") in MIGRATED:
                job["payload"]["argv"], cwd = MIGRATED[job["declarationKey"]]
                if cwd: job["payload"]["cwd"] = cwd
        self.store(migrated)
        def refuse(*args):
            raise AssertionError("no scheduler call expected")
        self.assertEqual(jcr.apply(home=self.home, call=refuse), {"state": "unchanged", "jobs": []})

    def test_running_job_and_missing_pin_target_are_left_running_where_they_were(self):
        self.store()
        jobs = copy.deepcopy(self.jobs)
        for job in jobs:
            if job["declarationKey"] == "samantha:agenda:sync-v2":
                job["state"] = {"runningAtMs": 1}
        (self.home / ".openclaw/runtime-ui-playbooks/current/tools/todos_daily.py").unlink()
        cron = FakeCron(jobs)
        out = jcr.apply(home=self.home, call=cron)
        self.assertEqual(out["state"], "partial")
        states = {r["key"]: (r["state"], r.get("reason")) for r in out["jobs"]}
        self.assertEqual(states["samantha:agenda:sync-v2"], ("skipped", "job_running"))
        self.assertEqual(states["samantha:todos:daily-1000"], ("skipped", "pin_lacks_target"))
        after = self.by_key(cron)
        self.assertEqual(after["samantha:todos:daily-1000"]["payload"]["argv"][2],
                         "cd $HOME/.openclaw/workspace/ui-playbooks && python3 tools/todos_daily.py --send")
        self.assertEqual(states["samantha:context-guardian"], ("migrated", None))

    def test_readback_mismatch_restores_the_original(self):
        self.store()
        cron = FakeCron(self.jobs, break_readback="samantha:context-compactor")
        out = jcr.apply(home=self.home, call=cron)
        self.assertEqual(out["state"], "attention_required")
        row = next(r for r in out["jobs"] if r["key"] == "samantha:context-compactor")
        self.assertEqual(row, {"key": "samantha:context-compactor", "state": "failed", "reason": "readback_mismatch_restored"})
        original = next(j for j in self.jobs if j["declarationKey"] == "samantha:context-compactor")["payload"]["argv"][2]
        self.assertEqual(self.by_key(cron)["samantha:context-compactor"]["payload"]["argv"][2], original)

    def test_cli_check_reads_the_store_read_only(self):
        self.store()
        db = self.home / ".openclaw/state/openclaw.sqlite"
        before = db.read_bytes()
        env = {**os.environ, "HOME": str(self.home)}; env.pop("OPENCLAW_STATE_DIR", None)
        out = subprocess.run([sys.executable, str(HERE / "job_code_root.py"), "--check"], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(len(json.loads(out.stdout)["drift"]), 6)
        self.assertEqual(before, db.read_bytes())

    def test_curator_reconciler_still_recognises_the_migrated_command(self):
        spec = __import__("importlib.util").util.spec_from_file_location("curator", HERE / "reconcile-memory-curator-cron.py")
        mod = __import__("importlib.util").util.module_from_spec(spec); spec.loader.exec_module(mod)
        job = next(j for j in self.jobs if j["declarationKey"] == mod.DECLARATION_KEY)
        job = copy.deepcopy(job); job["payload"]["argv"] = MIGRATED[mod.DECLARATION_KEY][0]
        self.assertEqual(mod.select_curator({"jobs": [job]})["id"], job["id"])


if __name__ == "__main__":
    unittest.main()
