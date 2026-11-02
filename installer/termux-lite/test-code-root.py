#!/usr/bin/env python3
"""Single code root (Amine 02/11/2026): pinned-first resolution, fallback that never blocks but is recorded,
drift report for runtime-sync.sh --check, and the Companion restart guard (lib.sh)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import code_root  # noqa: E402


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def init_repo(repo: Path, files: dict[str, str]) -> str:
    repo.mkdir(parents=True, exist_ok=True)
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture")
    return git(repo, "rev-parse", "HEAD")


class CodeRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.home = self.tmp / "home"
        self.pin_parent = self.home / ".openclaw/runtime-ui-playbooks"
        self.workspace = self.home / ".openclaw/workspace/ui-playbooks"
        self.events = self.home / ".openclaw/health/code-root/events"

    def make_pin(self, sha: str = "a" * 40, files=("skill_intelligence/capability_graph.py", "scheduling/runner.py")):
        snap = self.pin_parent / sha
        for rel in files:
            (snap / rel).parent.mkdir(parents=True, exist_ok=True)
            (snap / rel).write_text("import os;print(os.environ[\"PWD\"])\n")
        link = self.pin_parent / "current"
        if link.is_symlink():
            link.unlink()
        link.symlink_to(snap)
        return link

    def make_workspace(self, files=("skill_intelligence/capability_graph.py", "scheduling/runner.py")):
        for rel in files:
            (self.workspace / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.workspace / rel).write_text("import os;print(os.environ[\"PWD\"])\n")

    def event(self, component: str) -> dict:
        return json.loads((self.events / f"{component}.json").read_text())

    # Resolution -----------------------------------------------------------------------------------------------
    def test_pin_present_wins_without_event(self):
        pin = self.make_pin(); self.make_workspace()
        self.assertEqual(code_root.ui_playbooks_root("t", "scheduling/runner.py", home=self.home), pin)
        self.assertFalse(self.events.exists())

    def test_pin_missing_falls_back_to_workspace_and_records_once(self):
        self.make_workspace()
        root = code_root.ui_playbooks_root("claw_job_run", "scheduling/runner.py", home=self.home)
        self.assertEqual(root, self.workspace)
        row = self.event("claw_job_run")
        self.assertEqual((row["event"], row["reason"]), ("fallback", "pin_missing"))
        first = (self.events / "claw_job_run.json").stat().st_mtime
        code_root.ui_playbooks_root("claw_job_run", "scheduling/runner.py", home=self.home)
        self.assertEqual(first, (self.events / "claw_job_run.json").stat().st_mtime, "throttled, not one write per call")

    def test_pin_without_the_file_is_a_named_fallback(self):
        self.make_pin(files=("skill_intelligence/capability_graph.py",)); self.make_workspace()
        self.assertEqual(code_root.ui_playbooks_root("x", "scheduling/runner.py", home=self.home), self.workspace)
        self.assertEqual(self.event("x")["reason"], "pin_lacks_file")

    def test_override_used_only_when_it_carries_the_file(self):
        pin = self.make_pin()
        custom = self.tmp / "custom"; (custom / "scheduling").mkdir(parents=True); (custom / "scheduling/runner.py").write_text("")
        self.assertEqual(code_root.ui_playbooks_root("t", "scheduling/runner.py", [str(custom)], home=self.home), custom)
        self.assertEqual(code_root.ui_playbooks_root("t", "scheduling/runner.py", [str(self.tmp / "empty")], home=self.home), pin)

    def test_nothing_anywhere_is_none_and_cli_exit_3(self):
        self.assertIsNone(code_root.ui_playbooks_root("t", "scheduling/runner.py", home=self.home))
        run = subprocess.run([sys.executable, str(HERE / "code_root.py"), "resolve", "--component", "t", "--require", "x.py"],
                             env={**os.environ, "HOME": str(self.home)}, capture_output=True, text=True)
        self.assertEqual(run.returncode, 3)

    def test_claw_job_run_executes_from_the_pin_then_falls_back(self):
        self.make_workspace(); pin = self.make_pin()
        env = {k: v for k, v in os.environ.items() if k != "CLAW_UI_PLAYBOOKS_ROOT"}
        env.update(HOME=str(self.home), PATH=f"{self.tmp / 'bin'}:{env['PATH']}")
        (self.tmp / "bin").mkdir(); (self.tmp / "bin/python").symlink_to(sys.executable)
        script = (HERE / "claw-job-run.sh").read_text().replace("#!/data/data/com.termux/files/usr/bin/bash", "#!/usr/bin/env bash")
        runtime = self.tmp / "runtime"; runtime.mkdir()
        (runtime / "claw-job-run.sh").write_text(script); shutil.copy2(HERE / "code_root.py", runtime / "code_root.py")
        out = subprocess.run(["bash", str(runtime / "claw-job-run.sh"), "job"], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), str(pin))
        (pin).unlink()
        out = subprocess.run(["bash", str(runtime / "claw-job-run.sh"), "job"], env=env, capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), str(self.workspace), "never blocking: the job still runs")
        self.assertEqual(self.event("claw_job_run")["event"], "fallback")

    def test_shell_callers_use_the_resolver(self):
        for name, component in (("claw-job-run.sh", "claw_job_run"), ("learning-gate-close.sh", "learning_gate_close"),
                                ("context-dream.sh", "context_dream")):
            text = (HERE / name).read_text()
            self.assertIn("code_root.py\" resolve --component " + component, text, name)

    # Drift report ---------------------------------------------------------------------------------------------
    def test_check_reports_drift_and_dev_only_advisories(self):
        report = code_root.check(None, home=self.home, jobs=False)
        self.assertIn("code_root:playbooks_pin_missing", report["drift"])
        self.assertIn("skills:no_activation_baseline", report["advisory"])
        sha = init_repo(self.workspace, {"skill_intelligence/capability_graph.py": "", "scheduling/runner.py": ""})
        self.make_pin("b" * 40)
        core = self.tmp / "core"; init_repo(core, {"README.md": "x\n"})
        skills = self.home / ".openclaw/workspace/skills/samantha-x"; skills.mkdir(parents=True)
        (skills / "SKILL.md").write_text("v1\n"); (skills / ".openclaw").mkdir(); (skills / ".openclaw/state").write_text("ignored")
        code_root.record_baseline("activation", "b" * 40, home=self.home)
        report = code_root.check(core, home=self.home, jobs=False)
        self.assertEqual(report["drift"], [])
        self.assertEqual(report["advisory"], [f"working_copy:playbooks_head_{sha[:8]}_pin_bbbbbbbb"])
        # A hand edit: skills, a dirty core checkout, a dirty dev copy and a recent fallback.
        (skills / "SKILL.md").write_text("edited on the phone\n")
        (core / "README.md").write_text("dirty\n")
        (self.workspace / "scheduling/runner.py").write_text("dev edit\n")
        code_root.record_event("model_fast_path", "fallback", self.workspace, home=self.home)
        report = code_root.check(core, home=self.home, jobs=False)
        self.assertEqual(report["drift"], ["code_root:model_fast_path:fallback", "working_copy:core_dirty", "skills:changed_since_activation"])
        self.assertIn("working_copy:playbooks_dirty", report["advisory"])
        # Dot-directories (skill runtime state) never count; an old event leaves the window.
        (skills / "SKILL.md").write_text("v1\n"); (skills / ".openclaw/state").write_text("changed state")
        old = time.time() - 3 * 3600
        os.utime(self.events / "model_fast_path.json", (old, old))
        git(core, "checkout", "-q", "--", "README.md")
        self.assertEqual(code_root.check(core, home=self.home, jobs=False)["drift"], [])

    def test_check_includes_job_roots(self):
        report = code_root.check(None, home=self.home)
        self.assertNotIn("jobs:unreadable_ImportError", report["advisory"])

    # Companion restart guard (lib.sh + companion-server.sh + companion-deploy.sh) ------------------------------
    def state(self, repo: Path, **env) -> str:
        cmd = 'source "$1"; clawmobile_code_root_state "$2"'
        full = {**{k: v for k, v in os.environ.items() if k != "CLAWMOBILE_DEPLOY_CANDIDATE"}, "HOME": str(self.home), **env}
        return subprocess.run(["bash", "-c", cmd, "_", str(HERE / "lib.sh"), str(repo)], env=full, capture_output=True,
                              text=True, check=True).stdout.strip()

    def test_companion_guard_states(self):
        repo = self.tmp / "ClawMobile"
        head = init_repo(repo, {"openclaw-plugin-mobile-ui/src/a.ts": "a\n", "installer/workspace-seed-lite/skills/x/SKILL.md": "s\n"})
        self.assertEqual(self.state(repo), "ok", "no Tier0 release: install/dev host keeps the previous behaviour")
        release = self.home / ".openclaw/releases/current"; release.mkdir(parents=True)
        (release / "manifest.json").write_text(json.dumps({"source_commit": head}))
        self.assertEqual(self.state(repo), "ok")
        (repo / "openclaw-plugin-mobile-ui/src/new.ts").write_text("untracked\n")
        self.assertEqual(self.state(repo), "dirty")
        (repo / "openclaw-plugin-mobile-ui/src/new.ts").unlink()
        (repo / "installer/workspace-seed-lite/skills/x/SKILL.md").write_text("edited\n")
        self.assertEqual(self.state(repo), "dirty")
        git(repo, "checkout", "-q", "--", ".")
        git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "local commit")
        self.assertEqual(self.state(repo), "head_differs", "a local commit is not a deploy")
        self.assertEqual(self.state(repo, CLAWMOBILE_DEPLOY_CANDIDATE=git(repo, "rev-parse", "HEAD")), "ok")
        (release / "manifest.json").write_text("{")
        self.assertEqual(self.state(repo), "release_unreadable")

    def test_companion_start_skips_build_and_seed_but_keeps_starting(self):
        text = (HERE / "companion-server.sh").read_text()
        guard = text.index('CODE_ROOT_STATE="$(clawmobile_code_root_state "$REPO_ROOT")"')
        self.assertLess(guard, text.index('clawmobile_build_plugin_lite "$REPO_ROOT"'))
        self.assertIn('if [ "$CODE_ROOT_STATE" = ok ]; then\n  clawmobile_sync_workspace_seed "$REPO_ROOT"', text)
        self.assertIn("code_root_event companion_build skipped", text)
        self.assertIn("code_root_event companion_seed skipped", text)
        self.assertIn('elif [ ! -f "$PLUGIN_DIR/dist/companion/server.js" ]', text, "no dist: build anyway, never refuse to start")
        self.assertIn('node "$PLUGIN_DIR/dist/companion/server.js"', text)
        self.assertNotIn("exit 1", text[guard:text.index('node "$PLUGIN_DIR/dist/companion/server.js"')])
        deploy = (HERE / "companion-deploy.sh").read_text()
        self.assertIn('CLAWMOBILE_DEPLOY_CANDIDATE="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" nohup "$ROOT/companion-server.sh"', deploy)
        self.assertIn('if clawmobile_source_dirty "$REPO_ROOT" openclaw-plugin-mobile-ui; then', (HERE / "run.sh").read_text())

    def test_activation_and_deploy_follow_up(self):
        activate = (HERE / "activate-ui-playbooks.sh").read_text()
        self.assertIn('job_code_root.py" --apply', activate)
        self.assertIn('code_root.py" baseline --source activation --playbooks "$sha"', activate)
        self.assertLess(activate.index("code_root_follow\necho \"ACTIVATED"), activate.index('echo "ACTIVATED $sha'))
        self.assertIn("compile_views; code_root_follow; echo \"ALREADY_ACTIVE", activate)
        sync = (HERE / "runtime-sync.sh").read_text()
        self.assertIn('python3 "$SRC/job_code_root.py" --apply >&2 ||', sync)
        self.assertIn('python3 "$SRC/code_root.py" check --core-repo "$REPO"', sync)


if __name__ == "__main__":
    unittest.main()
