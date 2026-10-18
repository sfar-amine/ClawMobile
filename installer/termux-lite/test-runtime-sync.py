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
RSYNC_STUB = r'''#!/usr/bin/env python3
import pathlib, shutil, sys
src, dst = map(pathlib.Path, sys.argv[-2:])
dst.mkdir(parents=True, exist_ok=True)
for path in dst.iterdir():
    if path.name == "node_modules": continue
    shutil.rmtree(path) if path.is_dir() else path.unlink()
for path in src.iterdir():
    if path.name == "node_modules": continue
    target = dst / path.name
    shutil.copytree(path, target) if path.is_dir() else shutil.copy2(path, target)
'''


class Companion(http.server.BaseHTTPRequestHandler):
    calls = []
    order_log = None
    healthz_failures = 0
    healthz_logged = False
    def log_message(self, *a): pass
    def answer(self):
        Companion.calls.append((self.command, self.path))
        if self.path == "/healthz":
            if Companion.healthz_failures > 0:
                Companion.healthz_failures -= 1
                self.send_response(503); self.end_headers(); return
            if Companion.order_log and Companion.healthz_logged:
                with open(Companion.order_log, "a") as f: f.write("gateway-ready\n")
        if self.path == "/v1/runtime/restart" and Companion.order_log:
            with open(Companion.order_log, "a") as f: f.write("gateway-restart\n")
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
        Companion.calls.clear(); Companion.healthz_failures = 0; Companion.healthz_logged = False
        self.tmp = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.tmp)
        repo = self.tmp / "repo"; self.root = repo / "installer/termux-lite"; self.root.mkdir(parents=True)
        for name in ("runtime-sync.sh", "runtime_mode.py", "lib.sh", "companion-deploy.sh", "companion-acceptance.py", "project-room.py", "pulse-room.py", "contacts-agent.md"):
            shutil.copy2(HERE / name, self.root / name)
        compat = self.root / "openclaw-compat"; compat.mkdir()
        (compat / "whatsapp-network-recovery.py").write_text('import json,os,sys\nstate=os.environ.get("STUB_WA_PATCH","unchanged")\nprint(json.dumps({"ok":state!="refused","state":state}))\nsys.exit(1 if state=="refused" else 0)\n')
        (self.root / "install-tier0-control.py").write_text(TIER0_STUB)
        plugin = repo / PLUGIN_ID; (plugin / "dist").mkdir(parents=True)
        (plugin / "package.json").write_text('{"name":"openclaw-plugin-mobile-ui"}')
        (plugin / "openclaw.plugin.json").write_text('{"id":"openclaw-plugin-mobile-ui"}')
        (plugin / "dist/index.js").write_text("require('./pulseRoomFastPath')\n")
        (plugin / "dist/pulseRoomFastPath.js").write_text("// room\n")
        # Public source contracts only; no synthetic account/runtime payload.
        for rel in ("installer/termux-lite/model-fast-path.py", "openclaw-plugin-mobile-ui/src/companion/runWeb.ts", "openclaw-plugin-mobile-ui/fixtures/protocol/voice-v2-app-companion.json"):
            dest = repo / rel; dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(HERE.parent.parent / rel, dest)
        app = repo / "android/samantha/app/src/test/resources/voice-v2/app-companion-envelope-contract.json"
        app.parent.mkdir(parents=True); shutil.copy2(plugin / "fixtures/protocol/voice-v2-app-companion.json", app)
        git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q"); git("add", "-A")
        git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"); self.commit = git("rev-parse", "HEAD")
        self.home = self.tmp / "home"; oc = self.home / ".openclaw"
        Companion.order_log = str(self.home / "tier0.log")
        self.ext = oc / "extensions" / PLUGIN_ID; (self.ext / "dist").mkdir(parents=True); (self.ext / "node_modules/dep").mkdir(parents=True)
        shutil.copy2(plugin / "package.json", self.ext); shutil.copy2(plugin / "openclaw.plugin.json", self.ext)
        (self.ext / "dist/index.js").write_text("// 11/10 copy\n"); (self.ext / "node_modules/dep/x.js").write_text("dep")
        (oc / "tools").mkdir(); (oc / "tools/companion-deploy.sh").write_text("# stale deploy copy\n")
        (oc / "tier0/bin").mkdir(parents=True); (oc / "tier0/bin/tier0-control.py").write_text(PRUNE_STUB)
        cur = oc / "releases/current"; cur.mkdir(parents=True); (cur / "manifest.json").write_text('{"source_commit":"f3a19105"}')
        # Rooms and plain contacts hold stale rules (no no-invention rule), as on the S24 before 12/10.
        self.rooms = {"project": self.tmp / "workspace-projet", "pulse": oc / "workspace-pulse"}
        for room in self.rooms.values():
            room.mkdir(); (room / "AGENTS.md").write_text("# old rules\n"); (room / "USER.md").write_text("# old\n")
        (oc / "workspace-contacts").mkdir(); (oc / "workspace-contacts/AGENTS.md").write_text("# old contacts rules\n")
        # Playbooks rules installer (dry run prints planned/unchanged) and the Gateway's dispatch contract.
        self.rules_state = self.tmp / "rules-state"; self.rules_state.write_text("unchanged")
        pb = oc / "runtime-ui-playbooks/current/tools"; pb.mkdir(parents=True)
        (pb / "install_interaction_rules.py").write_text(f'import json;print(json.dumps([{{"file":"context/OPERATING_RULES.md","state":open({str(self.rules_state)!r}).read()}}]))\n')
        self.dist = self.tmp / "openclaw-dist"; self.dist.mkdir()
        (self.dist / "dispatch-from-config-X.mjs").write_text("hookRunner.runBeforeDispatch(event)")
        bin_ = self.tmp / "bin"; bin_.mkdir(); (bin_ / "openclaw").write_text(OPENCLAW_STUB); (bin_ / "openclaw").chmod(0o755)
        owner = oc / "runtime-ui-playbooks/current/skill_intelligence/public_web.py"
        owner.parent.mkdir(parents=True, exist_ok=True)
        owner.write_text("BUDGET_MS=20000\nSEARCH_BUDGET_MS=12000\n")
        # rsync is installed on Termux but optional on generic Ubuntu hosts.
        # The double preserves the --delete contract and the node_modules exclusion.
        (bin_ / "rsync").write_text(RSYNC_STUB); (bin_ / "rsync").chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{bin_}:{os.environ['PATH']}", RUNTIME_SYNC_POLL_S="0", RUNTIME_SYNC_OPENCLAW_DIST=str(self.dist),
                        CLAW_PROJECT_ROOM_DIR=str(self.rooms["project"]), CLAW_PULSE_ROOM_DIR=str(self.rooms["pulse"]),
                        RUNTIME_SYNC_COMPANION_URL=f"http://127.0.0.1:{self.server.server_address[1]}",
                        RUNTIME_SYNC_GATEWAY_HEALTHZ_URL=f"http://127.0.0.1:{self.server.server_address[1]}/healthz")
        self.env.pop("OPENCLAW_STATE_DIR", None)

    def sync(self, commit=None, check=False, **env):
        args = ["--check"] if check else []
        out = subprocess.run(["bash", str(self.root / "runtime-sync.sh"), *args, commit or self.commit], env={**self.env, **env},
                             capture_output=True, text=True, timeout=60)
        return out.returncode, json.loads(out.stdout.strip().splitlines()[-1]), out.stderr

    def tier0_log(self):
        path = self.home / "tier0.log"
        return path.read_text().splitlines() if path.exists() else []

    def test_stale_gateway_plugin_and_release_are_brought_to_the_commit(self):
        rc, out, err = self.sync()
        self.assertEqual(0, rc, err)
        self.assertEqual({"ok": True, "commit": self.commit, "plugin": "synced", "release": "promoted", "gateway": "restarted", "tools": "synced", "rules": "synced"}, out)
        self.assertIn("inventes jamais", (self.rooms["project"] / "AGENTS.md").read_text())
        self.assertIn("inventes jamais", (self.rooms["pulse"] / "AGENTS.md").read_text())
        self.assertEqual((self.root / "contacts-agent.md").read_text(), (self.home / ".openclaw/workspace-contacts/AGENTS.md").read_text())
        self.assertEqual("// room\n", (self.ext / "dist/pulseRoomFastPath.js").read_text())
        self.assertEqual("dep", (self.ext / "node_modules/dep/x.js").read_text())  # the Gateway's installed deps stay
        manifest = json.loads((self.home / ".openclaw/releases/current/manifest.json").read_text())
        self.assertEqual(self.commit, manifest["source_commit"])
        # S24 12/10: the Gateway restarts before the Tier0 promotion, never inside its soak window.
        self.assertEqual(["gateway-restart", "--apply", "prune --keep 5 --apply"], self.tier0_log())
        self.assertEqual((self.root / "companion-deploy.sh").read_text(), (self.home / ".openclaw/tools/companion-deploy.sh").read_text())
        self.assertEqual(("POST", "/v1/runtime/restart"), Companion.calls[0])
        self.assertIn(("GET", "/v1/control/health?contract=2"), Companion.calls)

    def test_promotion_waits_for_gateway_readiness_not_only_control_http(self):
        # S24 16/10: Control answered 200 while the Gateway was still restarting; the soak consumed that sample.
        Companion.healthz_failures = 2; Companion.healthz_logged = True
        code, out, err = self.sync()
        self.assertEqual(0, code, err); self.assertEqual("restarted", out["gateway"])
        self.assertEqual(["gateway-restart", "gateway-ready", "--apply", "prune --keep 5 --apply"], self.tier0_log())
        self.assertEqual(3, sum(1 for c in Companion.calls if c[1] == "/healthz"))

    def test_gateway_never_ready_fails_before_promotion(self):
        Companion.healthz_failures = 10**6
        code, out, err = self.sync()
        self.assertEqual(1, code); self.assertEqual("gateway_not_ready", out["reason"])
        self.assertEqual(["gateway-restart"], self.tier0_log())

    def test_a_second_sync_changes_nothing_and_keeps_the_gateway_running(self):
        self.sync(); Companion.calls.clear(); before = self.tier0_log()
        rc, out, err = self.sync()
        self.assertEqual(0, rc, err)
        self.assertEqual({"ok": True, "commit": self.commit, "plugin": "unchanged", "release": "unchanged", "gateway": "unchanged", "tools": "unchanged", "rules": "unchanged"}, out)
        self.assertEqual([], Companion.calls); self.assertEqual(before, self.tier0_log())

    def test_new_whatsapp_patch_restarts_even_when_plugin_already_matches(self):
        self.sync(); Companion.calls.clear()
        rc, out, err = self.sync(STUB_WA_PATCH="applied")
        self.assertEqual(0, rc, err)
        self.assertEqual("restarted", out["gateway"])
        self.assertIn(("POST", "/v1/runtime/restart"), Companion.calls)

    def test_unsupported_whatsapp_patch_refuses_sync_and_is_reported_as_drift(self):
        rc, out, _ = self.sync(STUB_WA_PATCH="refused")
        self.assertEqual((1, "whatsapp_network_recovery_refused"), (rc, out["reason"]))
        self.assertEqual([], Companion.calls)
        rc, out, _ = self.sync(check=True, STUB_WA_PATCH="refused")
        self.assertEqual(1, rc)
        self.assertIn("openclaw:whatsapp_network_recovery", out["drift"])

    def test_a_release_left_on_another_commit_fails_the_sync(self):
        rc, out, _ = self.sync(STUB_RELEASE_COMMIT="f3a19105")
        self.assertEqual(1, rc); self.assertEqual("release_commit_differs", out["reason"])

    def test_a_checkout_on_another_commit_is_refused_before_any_copy(self):
        rc, out, _ = self.sync(commit="0" * 40)
        self.assertEqual(3, rc); self.assertEqual("checkout_not_at_commit", out["reason"])
        self.assertEqual("// 11/10 copy\n", (self.ext / "dist/index.js").read_text()); self.assertEqual([], self.tier0_log())

    def test_check_reports_every_drift_and_changes_nothing(self):
        rc, out, _ = self.sync(check=True)
        self.assertEqual(1, rc)
        self.assertEqual({"gateway_plugin", "tier0_release", "tool:companion-deploy.sh", "rules:project_room", "rules:pulse_room", "rules:contacts"}, set(out["drift"]))
        self.assertEqual("// 11/10 copy\n", (self.ext / "dist/index.js").read_text()); self.assertEqual([], self.tier0_log())
        self.sync()
        rc, out, err = self.sync(check=True)
        self.assertEqual((0, {"ok": True, "commit": self.commit, "drift": []}), (rc, out), err)
        # Drift that appears after a deploy: a hand edit, a playbooks rule left uninstalled, an OpenClaw upgrade.
        (self.home / ".openclaw/workspace-contacts/AGENTS.md").write_text("# edited by hand\n")
        self.rules_state.write_text("planned")
        (self.dist / "dispatch-from-config-X.mjs").write_text("// before_dispatch no longer dispatched")
        rc, out, _ = self.sync(check=True)
        self.assertEqual(1, rc); self.assertEqual(["rules:contacts", "rules:operating", "openclaw:before_dispatch_missing"], out["drift"])

    def test_a_gateway_without_before_dispatch_fails_the_deploy_sync(self):
        (self.dist / "dispatch-from-config-X.mjs").write_text("// gone")
        rc, out, _ = self.sync()
        self.assertEqual(1, rc); self.assertEqual("openclaw_before_dispatch_missing", out["reason"])

    def test_health_manager_and_playbooks_activation_keep_it_aligned(self):
        health = (HERE / "samantha-health-manager.sh").read_text()
        self.assertIn('"$ROOT/runtime-sync.sh" --check', health)
        self.assertIn(" check_runtime_drift\n sleep 15", health)
        activate = (HERE / "activate-ui-playbooks.sh").read_text()
        self.assertIn('tools/install_interaction_rules.py" --apply', activate)
        self.assertLess(activate.index("install_interaction_rules.py"), activate.index("ALREADY_ACTIVE"))

    def test_deploy_and_rollback_both_bring_the_runtime_copies(self):
        text = (HERE / "companion-deploy.sh").read_text()
        self.assertIn('runtime=$(sync_runtime "$full") || rollback runtime_sync_failed', text)
        self.assertIn('runtime=$(sync_runtime "$previous")', text)
        self.assertLess(text.index('rollback acceptance_failed'), text.index('sync_runtime "$full"'))
        self.assertLess(text.index('sync_runtime "$full"'), text.index('write deployed'))


if __name__ == "__main__":
    unittest.main()
