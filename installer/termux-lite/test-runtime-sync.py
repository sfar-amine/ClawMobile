#!/usr/bin/env python3
"""S24 12/10: the Companion was deployed (1d7676ca) but the WhatsApp Gateway still loaded its 11/10 plugin copy and
the 10:34 Tier0 release: Sadok's Pulse room was answered by the model, which invented a project status.
runtime-sync.sh brings every runtime copy to the deployed commit and proves it; the deploy fails otherwise."""
import http.server, json, os, pathlib, shutil, subprocess, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent
PLUGIN_ID = "openclaw-plugin-mobile-ui"
TIER0_STUB = r'''#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys
home=pathlib.Path.home(); src=pathlib.Path(__file__).resolve().parent
commit=os.environ.get("STUB_RELEASE_COMMIT") or subprocess.run(["git","-C",str(src),"rev-parse","HEAD"],capture_output=True,text=True).stdout.strip()
cur=home/".openclaw/releases/current"; cur.mkdir(parents=True,exist_ok=True)
(cur/"manifest.json").write_text(json.dumps({"source_commit":commit}))
with open(home/"tier0.log","a") as f: f.write(" ".join(sys.argv[1:])+"\n")
'''
PRUNE_STUB = '#!/usr/bin/env python3\nimport pathlib,sys\nopen(pathlib.Path.home()/"tier0.log","a").write(" ".join(sys.argv[1:])+"\\n")\n'
OPENCLAW_STUB = f'#!/bin/sh\necho "$@" >> "$HOME/openclaw.log"\n[ "$1 $2" = "plugins list" ] && echo {PLUGIN_ID}\nexit 0\n'


class Companion(http.server.BaseHTTPRequestHandler):
    calls = []
    def log_message(self, *a): pass
    def answer(self):
        Companion.calls.append((self.command, self.path))
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    do_GET = do_POST = answer


class RuntimeSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Companion)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Companion.calls.clear()
        self.tmp = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.tmp)
        repo = self.tmp / "repo"; self.root = repo / "installer/termux-lite"; self.root.mkdir(parents=True)
        for name in ("runtime-sync.sh", "lib.sh", "companion-deploy.sh", "companion-acceptance.py"):
            shutil.copy2(HERE / name, self.root / name)
        (self.root / "install-tier0-control.py").write_text(TIER0_STUB)
        plugin = repo / PLUGIN_ID; (plugin / "dist").mkdir(parents=True)
        (plugin / "package.json").write_text('{"name":"openclaw-plugin-mobile-ui"}')
        (plugin / "openclaw.plugin.json").write_text('{"id":"openclaw-plugin-mobile-ui"}')
        (plugin / "dist/index.js").write_text("require('./pulseRoomFastPath')\n")
        (plugin / "dist/pulseRoomFastPath.js").write_text("// room\n")
        git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q"); git("add", "-A")
        git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"); self.commit = git("rev-parse", "HEAD")
        self.home = self.tmp / "home"; oc = self.home / ".openclaw"
        self.ext = oc / "extensions" / PLUGIN_ID; (self.ext / "dist").mkdir(parents=True); (self.ext / "node_modules/dep").mkdir(parents=True)
        shutil.copy2(plugin / "package.json", self.ext); shutil.copy2(plugin / "openclaw.plugin.json", self.ext)
        (self.ext / "dist/index.js").write_text("// 11/10 copy\n"); (self.ext / "node_modules/dep/x.js").write_text("dep")
        (oc / "tools").mkdir(); (oc / "tools/companion-deploy.sh").write_text("# stale deploy copy\n")
        (oc / "tier0/bin").mkdir(parents=True); (oc / "tier0/bin/tier0-control.py").write_text(PRUNE_STUB)
        cur = oc / "releases/current"; cur.mkdir(parents=True); (cur / "manifest.json").write_text('{"source_commit":"f3a19105"}')
        bin_ = self.tmp / "bin"; bin_.mkdir(); (bin_ / "openclaw").write_text(OPENCLAW_STUB); (bin_ / "openclaw").chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{bin_}:{os.environ['PATH']}", RUNTIME_SYNC_POLL_S="0",
                        RUNTIME_SYNC_COMPANION_URL=f"http://127.0.0.1:{self.server.server_address[1]}")
        self.env.pop("OPENCLAW_STATE_DIR", None)

    def sync(self, commit=None, **env):
        out = subprocess.run(["bash", str(self.root / "runtime-sync.sh"), commit or self.commit], env={**self.env, **env},
                             capture_output=True, text=True, timeout=60)
        return out.returncode, json.loads(out.stdout.strip().splitlines()[-1]), out.stderr

    def tier0_log(self):
        path = self.home / "tier0.log"
        return path.read_text().splitlines() if path.exists() else []

    def test_stale_gateway_plugin_and_release_are_brought_to_the_commit(self):
        rc, out, err = self.sync()
        self.assertEqual(0, rc, err)
        self.assertEqual({"ok": True, "commit": self.commit, "plugin": "synced", "release": "promoted", "gateway": "restarted", "tools": "synced"}, out)
        self.assertEqual("// room\n", (self.ext / "dist/pulseRoomFastPath.js").read_text())
        self.assertEqual("dep", (self.ext / "node_modules/dep/x.js").read_text())  # the Gateway's installed deps stay
        manifest = json.loads((self.home / ".openclaw/releases/current/manifest.json").read_text())
        self.assertEqual(self.commit, manifest["source_commit"])
        self.assertEqual(["--apply", "prune --keep 10 --apply"], self.tier0_log())
        self.assertEqual((self.root / "companion-deploy.sh").read_text(), (self.home / ".openclaw/tools/companion-deploy.sh").read_text())
        self.assertEqual(("POST", "/v1/runtime/restart"), Companion.calls[0])
        self.assertIn(("GET", "/v1/control/health?contract=2"), Companion.calls)

    def test_a_second_sync_changes_nothing_and_keeps_the_gateway_running(self):
        self.sync(); Companion.calls.clear(); before = self.tier0_log()
        rc, out, err = self.sync()
        self.assertEqual(0, rc, err)
        self.assertEqual({"ok": True, "commit": self.commit, "plugin": "unchanged", "release": "unchanged", "gateway": "unchanged", "tools": "unchanged"}, out)
        self.assertEqual([], Companion.calls); self.assertEqual(before, self.tier0_log())

    def test_a_release_left_on_another_commit_fails_the_sync(self):
        rc, out, _ = self.sync(STUB_RELEASE_COMMIT="f3a19105")
        self.assertEqual(1, rc); self.assertEqual("release_commit_differs", out["reason"])

    def test_a_checkout_on_another_commit_is_refused_before_any_copy(self):
        rc, out, _ = self.sync(commit="0" * 40)
        self.assertEqual(3, rc); self.assertEqual("checkout_not_at_commit", out["reason"])
        self.assertEqual("// 11/10 copy\n", (self.ext / "dist/index.js").read_text()); self.assertEqual([], self.tier0_log())

    def test_deploy_and_rollback_both_bring_the_runtime_copies(self):
        text = (HERE / "companion-deploy.sh").read_text()
        self.assertIn('runtime=$(sync_runtime "$full") || rollback runtime_sync_failed', text)
        self.assertIn('runtime=$(sync_runtime "$previous")', text)
        self.assertLess(text.index('rollback acceptance_failed'), text.index('sync_runtime "$full"'))
        self.assertLess(text.index('sync_runtime "$full"'), text.index('write deployed'))


if __name__ == "__main__":
    unittest.main()
