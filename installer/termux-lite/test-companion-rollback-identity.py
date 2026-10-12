#!/usr/bin/env python3
"""R03 (doc 52, 1.1): companion-deploy.sh judged its rollback with the full performance acceptance. Under load a
slow read or a transient 503 right after the restart wrote rollback_failed and sent a false "rollback not healthy"
alert. The rollback is now judged on identity (checkout HEAD = previous, restored dist = backup hash) and on
/v1/health with a bounded retry; the result goes to rollback_acceptance, acceptance keeps the failed check.

The real companion-deploy.sh runs end to end in a temporary checkout, with stubs on PATH (curl, npm, pgrep, pkill,
uptime, sleep) and in the checkout (acceptance always failing, runtime-sync.sh, incident-notify.sh)."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
REAL_GIT = shutil.which("git")

STUBS = {
    # /v1/health answers the codes of FAKE_HEALTH_SEQ in turn, the last one repeated; control health is ready.
    "curl": r'''#!/bin/sh
for a in "$@"; do url="$a"; done
echo "$url" >> "$HOME/curl.log"
case "$url" in
  */v1/health)
    n=$(grep -c '/v1/health$' "$HOME/curl.log")
    code=$(echo "$FAKE_HEALTH_SEQ" | tr ',' '\n' | sed -n "${n}p"); [ -n "$code" ] || code=$(echo "$FAKE_HEALTH_SEQ" | tr ',' '\n' | tail -1)
    [ "$code" = 200 ] && exit 0 || exit 22 ;;
  *) printf 200 ;;
esac
''',
    # The build writes a new dist; FAKE_TAMPER_BACKUP alters the saved copy so the restore no longer matches it.
    "npm": r'''#!/bin/sh
echo "built target" > dist/index.js
if [ -n "$FAKE_TAMPER_BACKUP" ]; then for d in "$HOME"/.openclaw/backups/companion-*/dist; do echo tampered > "$d/index.js"; done; fi
exit "${FAKE_BUILD_RC:-0}"
''',
    # A real git, except that FAKE_GIT_IGNORE_RESET makes the rollback's reset a silent no-op.
    "git": f'''#!/bin/sh
if [ -n "$FAKE_GIT_IGNORE_RESET" ] && [ "$1" = reset ]; then exit 0; fi
exec {REAL_GIT} "$@"
''',
    "pgrep": '#!/bin/sh\n[ "$1" = -fc ] && echo 0\nexit 1\n',
    "pkill": '#!/bin/sh\nexit 1\n',
    "uptime": '#!/bin/sh\necho " 10:00:00 up 1 day,  2 users,  load average: 0.50, 0.40, 0.30"\n',
    "sleep": '#!/bin/sh\nexit 0\n',
}
CHECKOUT_STUBS = {
    # The full performance acceptance fails on both commits: it must no longer decide the rollback.
    "companion-acceptance.py": 'import json,pathlib\nopen(pathlib.Path.home()/"accept.log","a").write("run\\n")\n'
                               'print(json.dumps({"ok":False,"checks":[{"route":"/agent/config","status":"fail"}]}))\nraise SystemExit(1)\n',
    "runtime-sync.sh": '#!/bin/sh\necho "$1" >> "$HOME/runtime-sync.log"\necho "{\\"ok\\":true,\\"commit\\":\\"$1\\"}"\n',
    "incident-notify.sh": '#!/bin/sh\necho "$*" >> "$HOME/notify.log"\n',
    "companion-server.sh": '#!/bin/sh\nexit 0\n',
}


class RollbackIdentity(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.tmp)
        self.home = self.tmp / "home"; self.home.mkdir()
        bin_ = self.tmp / "bin"; bin_.mkdir()
        for name, body in STUBS.items():
            (bin_ / name).write_text(body); (bin_ / name).chmod(0o755)
        remote = self.tmp / "remote.git"
        repo = self.tmp / "repo"; self.root = repo / "installer/termux-lite"; self.root.mkdir(parents=True)
        for name in ("companion-deploy.sh", "bounded-log.py"):
            shutil.copy2(HERE / name, self.root / name)
        for name, body in CHECKOUT_STUBS.items():
            (self.root / name).write_text(body); (self.root / name).chmod(0o755)
        self.plugin = repo / "openclaw-plugin-mobile-ui"; (self.plugin / "dist/companion").mkdir(parents=True)
        (self.plugin / "dist/index.js").write_text("previous build\n"); (self.plugin / "dist/companion/server.js").write_text("// server\n")
        (repo / ".gitignore").write_text("openclaw-plugin-mobile-ui/dist/\n")
        git = lambda *a: subprocess.run([REAL_GIT, "-C", str(repo), *a], check=True, capture_output=True, text=True).stdout.strip()
        commit = lambda msg: git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg)
        git("init", "-q", "-b", "runtime/samantha-companion-private"); git("add", "-A"); commit("previous")
        self.previous = git("rev-parse", "HEAD")
        (repo / "marker.txt").write_text("target\n"); git("add", "-A"); commit("target")
        self.target = git("rev-parse", "HEAD")
        git("reset", "-q", "--hard", self.previous)
        subprocess.run([REAL_GIT, "init", "-q", "--bare", str(remote)], check=True)
        git("remote", "add", "samantha-private", str(remote))
        git("push", "-q", "samantha-private", f"{self.target}:refs/heads/runtime/samantha-companion-private")
        self.repo = repo
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{bin_}:{os.environ['PATH']}", COMPANION_DEPLOY_MIN_MB="0",
                        COMPANION_DEPLOY_MAX_LOAD="7", FAKE_HEALTH_SEQ="200")
        self.env.pop("CLAW_RUNTIME_ROOT", None)

    def deploy(self, **env):
        out = subprocess.run(["bash", str(self.root / "companion-deploy.sh"), self.target], env={**self.env, **env},
                             capture_output=True, text=True, timeout=120)
        receipts = sorted((self.home / ".openclaw/deploys").glob("companion-*.json"))
        self.assertTrue(receipts, out.stderr)
        return out.returncode, json.loads(receipts[-1].read_text())

    def lines(self, name):
        path = self.home / name
        return path.read_text().splitlines() if path.exists() else []

    def test_transient_503_after_the_rollback_restart_is_a_healthy_rollback(self):
        # Deploy restart ready at once; after the rollback restart, /v1/health answers 503 twice then 200.
        rc, receipt = self.deploy(FAKE_HEALTH_SEQ="200,503,503,200")
        self.assertEqual(6, rc)
        self.assertEqual("rolled_back", receipt["state"]); self.assertEqual("acceptance_failed", receipt["detail"])
        self.assertEqual([], self.lines("notify.log"))
        # acceptance keeps the failed check of the target; the rollback is judged apart, without the acceptance.
        self.assertFalse(receipt["acceptance"]["ok"])
        self.assertEqual(["run"], self.lines("accept.log"))
        rb = receipt["rollback_acceptance"]
        self.assertEqual({"head_is_previous": True, "dist_matches_backup": True, "health_ready": True}, rb["checks"])
        self.assertTrue(rb["ok"]); self.assertEqual("identity_and_health", rb["criterion"])
        self.assertEqual({"ok": True, "commit": self.previous}, receipt["runtime"])
        self.assertEqual([self.previous], self.lines("runtime-sync.log"))
        self.assertEqual("previous build\n", (self.plugin / "dist/index.js").read_text())
        self.assertEqual(self.previous, subprocess.run([REAL_GIT, "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip())

    def test_head_left_on_the_target_is_a_failed_rollback(self):
        rc, receipt = self.deploy(FAKE_GIT_IGNORE_RESET="1")
        self.assertEqual(6, rc)
        self.assertEqual("rollback_failed", receipt["state"])
        self.assertEqual({"head_is_previous": False, "dist_matches_backup": True, "health_ready": True}, receipt["rollback_acceptance"]["checks"])
        self.assertFalse(receipt["rollback_acceptance"]["ok"])
        self.assertEqual(1, len(self.lines("notify.log"))); self.assertIn("human_required", self.lines("notify.log")[0])
        self.assertEqual([], self.lines("runtime-sync.log"))

    def test_restored_dist_different_from_the_backup_is_a_failed_rollback(self):
        rc, receipt = self.deploy(FAKE_TAMPER_BACKUP="1")
        self.assertEqual(6, rc)
        self.assertEqual("rollback_failed", receipt["state"])
        self.assertEqual({"head_is_previous": True, "dist_matches_backup": False, "health_ready": True}, receipt["rollback_acceptance"]["checks"])
        self.assertEqual(1, len(self.lines("notify.log")))

    def test_health_never_ready_after_the_bounded_retry_is_a_failed_rollback(self):
        rc, receipt = self.deploy(FAKE_HEALTH_SEQ="200,503")
        self.assertEqual(6, rc)
        self.assertEqual("rollback_failed", receipt["state"])
        self.assertFalse(receipt["rollback_acceptance"]["checks"]["health_ready"])
        self.assertEqual(1, len(self.lines("notify.log")))
        # Bounded: one deploy probe, then 60 probes (2 s apart) for the rollback restart.
        self.assertEqual(61, sum(1 for l in self.lines("curl.log") if l.endswith("/v1/health")))

    def test_a_build_failure_rolls_back_without_any_acceptance(self):
        rc, receipt = self.deploy(FAKE_BUILD_RC="1")
        self.assertEqual(6, rc)
        self.assertEqual(("rolled_back", "build_failed"), (receipt["state"], receipt["detail"]))
        self.assertIsNone(receipt["acceptance"]); self.assertTrue(receipt["rollback_acceptance"]["ok"])
        self.assertEqual([], self.lines("accept.log")); self.assertEqual([], self.lines("notify.log"))
        self.assertEqual("previous build\n", (self.plugin / "dist/index.js").read_text())


if __name__ == "__main__":
    unittest.main()
