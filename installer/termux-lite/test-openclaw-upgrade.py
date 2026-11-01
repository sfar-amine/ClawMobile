#!/usr/bin/env python3
"""openclaw-upgrade.py off the S24: gates, automatic rollback, refusals, WAL-aware backup, no secret in receipts.

A fake `openclaw` (CLI + Gateway on a free loopback port) stands in for 2026.9.6 / 2026.10.9; its version is the
live tree's package.json, so the rename switch and the rollback are observed exactly as on the phone. SQLite
databases, config, credentials and the WhatsApp npm generation are real files in a temporary root.
"""
import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "openclaw-upgrade.py"
spec = importlib.util.spec_from_file_location("openclaw_upgrade", SCRIPT)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)

SECRET = "sk-test-SECRETVALUE-0123456789abcdef0123456789"
WA_GEN = "openclaw-whatsapp-290d7f7427__openclaw-generation__g-de2d383df15fe333"

FAKE_NPM = r'''
import json, os, sys
from pathlib import Path
assert sys.argv[1] == "install" and "--legacy-peer-deps" in sys.argv
if os.environ.get("FAKE_NPM_FAIL"): sys.exit(1)
spec = sys.argv[2]; version = spec.rsplit("@", 1)[1]
import shutil
shutil.rmtree("node_modules/@openclaw/whatsapp")  # npm replaces the package directory: the peer link goes
Path("node_modules/@openclaw/whatsapp").mkdir()
pkg = Path("node_modules/@openclaw/whatsapp/package.json")
pkg.write_text(json.dumps({"name": "@openclaw/whatsapp", "version": version}))
print("added 3 packages token=" + os.environ.get("FAKE_SECRET", ""))
'''

FAKE = r'''
import http.server, json, os, signal, sqlite3, sys, time
from pathlib import Path
root = Path(os.environ["FAKE_ROOT"])
def version():
    return json.loads((root / "live/openclaw/package.json").read_text())["version"]
state = Path(os.environ["OPENCLAW_STATE_DIR"])
args = sys.argv[1:]
v = version()
def out(doc): print("[plugins] noise before json"); print(json.dumps(doc))
if args[:1] == ["gateway"]:
    port = int(args[args.index("--port") + 1])
    if os.environ.get("FAKE_GATEWAY_DOWN_ON") == v:
        if os.environ.get("FAKE_TRIAGE"):
            print("Gateway failed to start: Secret egress proxy Worker is unavailable")
            print("Automatic triage is preparing the installed CLI; diagnostics will follow.", flush=True)
        sys.exit(3)
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(v.encode())
        def log_message(self, *a): pass
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    con = sqlite3.connect(state / "state/openclaw.sqlite")  # OpenClaw's owner lease, as on the S24
    con.execute("create table if not exists state_leases(scope text primary key, payload_json text)")
    con.execute("insert or replace into state_leases values('gateway-owner', ?)", (json.dumps({"owner": {"pid": os.getpid()}, "port": port}),))
    con.commit(); con.close()
    print("gateway token=" + os.environ.get("FAKE_SECRET", ""), flush=True)
    http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
elif args[:1] == ["doctor"]:
    watch = os.environ.get("FAKE_WATCH_PID")
    if watch:
        st = Path(f"/proc/{watch}/stat").read_text()
        (root / "watch-state-during-doctor").write_text(st[st.rindex(")") + 2])
    rc = int(os.environ.get("FAKE_DOCTOR_RC", "0"))
    time.sleep(float(os.environ.get("FAKE_DOCTOR_SLEEP", "0")))
    if v == "2026.10.9":
        for db in sorted(state.glob("agents/*/agent/openclaw-agent.sqlite")):
            con = sqlite3.connect(db); con.execute("PRAGMA user_version=25"); con.execute("create table migrated(x)"); con.commit(); con.close()
            print("Upgraded agent database schema in " + str(db) + ": v23 -> v25.")
        cfg = json.loads((state / "openclaw.json").read_text()); cfg["agents"]["defaults"] = {"systemAgent": {"agentId": "main"}}
        (state / "openclaw.json").write_text(json.dumps(cfg))
        (state / "credentials/whatsapp/creds.json").unlink()
        print("doctor saw token " + os.environ.get("FAKE_SECRET", ""))
    sys.exit(rc)
elif args[:2] == ["plugins", "update"]:
    gen = state / "npm/projects/openclaw-whatsapp-290d7f7427__openclaw-generation__g-0123456789abcdef/node_modules/@openclaw/whatsapp"
    gen.mkdir(parents=True); (gen / "package.json").write_text(json.dumps({"name": "@openclaw/whatsapp", "version": "2026.10.9"}))
elif args[:2] == ["health", "--json"]:
    out({"ok": True, "plugins": {"loaded": ["memory-core", "openclaw-plugin-mobile-ui"], "errors": []},
         "channels": {"whatsapp": {"self": {"e164": "+21600000000"}}}})
elif args[:3] == ["plugins", "inspect", "whatsapp"]:
    wa = sorted(state.glob("npm/projects/openclaw-whatsapp-*/node_modules/@openclaw/whatsapp/package.json"))
    ver = json.loads(wa[0].read_text())["version"] if len(wa) == 1 else None
    out({"plugin": {"status": "loaded" if ver else "error", "packageVersion": ver}})
elif args[:2] == ["plugins", "enable"]:
    assert "--accept-capabilities" in args
    (state / ("consent-" + args[2])).write_text(v)
elif args[:2] == ["plugins", "inspect"]:
    n = int(os.environ.get("FAKE_TOOLS", "42"))
    if v == "2026.10.9" and not (state / ("consent-" + args[2])).exists():
        n = 0  # 2026.10.9: no tool before the capability consent (S24 rehearsal)
    out({"plugin": {"status": "loaded", "toolNames": ["t%d" % i for i in range(n)], "contracts": {"tools": ["t"] * 56}}})
elif args[:1] == ["agent"]:
    if os.environ.get("FAKE_TURN_FAIL_ON") in (v, "all"):
        print(json.dumps({"status": "error", "error": "provider"})); sys.exit(1)
    out({"status": "ok", "result": {"payloads": [{"text": "prêt"}]}})
elif args[:2] == ["channels", "status"]:
    out({"channels": {"whatsapp": {"running": True, "connected": True, "linked": True, "self": {"e164": "+21600000000"}}}})
else:
    sys.exit(64)
'''


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Root:
    def __init__(self, td: Path, **overrides):
        self.td = td
        self.port = free_port()
        self.state = td / "state"
        live, cand = td / "live", td / "cand"
        for base, oc, node in ((live, "2026.9.6", (24, 21, 0)), (cand, "2026.10.9", (24, 22, 2))):
            (base / "openclaw").mkdir(parents=True)
            (base / "openclaw/package.json").write_text(json.dumps({"name": "openclaw", "version": oc}))
            (base / "openclaw/openclaw.mjs").write_text("// " + oc)
            header = base / "node/include/node/node_version.h"
            header.parent.mkdir(parents=True)
            header.write_text("".join(f"#define NODE_{n}_VERSION {v}\n" for n, v in zip(("MAJOR", "MINOR", "PATCH"), node)))
        self.make_db("state/openclaw.sqlite", rows=2000, wal=True)
        self.make_db("agents/main/agent/openclaw-agent.sqlite", rows=500, version=23)
        self.make_db("agents/gemini/agent/openclaw-agent.sqlite", rows=50, version=23)
        self.make_db("headless-state/state/openclaw.sqlite", rows=5)
        (self.state / "agents/main/agent/models.json").write_text('{"m":1}')
        (self.state / "openclaw.json").write_text(json.dumps({"agents": {}, "gateway": {"auth": {"token": SECRET}}}))
        (self.state / "credentials/whatsapp").mkdir(parents=True)
        (self.state / "credentials/whatsapp/creds.json").write_text(json.dumps({"noiseKey": SECRET}))
        wa = self.state / "npm/projects" / WA_GEN / "node_modules/@openclaw/whatsapp"
        wa.mkdir(parents=True)
        (wa / "package.json").write_text(json.dumps({"name": "@openclaw/whatsapp", "version": "2026.9.6"}))
        (wa / "node_modules").mkdir()
        os.symlink(str(live / "openclaw"), wa / "node_modules/openclaw")  # OpenClaw's peer link, as on the S24
        (td / "fake-npm.py").write_text(FAKE_NPM)
        dist = self.state / "extensions/openclaw-plugin-mobile-ui/dist/companion"
        dist.mkdir(parents=True)
        (dist / "openclawSdkVersions.js").write_text('const T={"2026.9.6":{},"2026.10.9":{}};')
        fake = td / "fake-openclaw.py"
        fake.write_text(FAKE)
        (td / "notify.sh").write_text(f"#!/bin/sh\necho \"$@\" >> {td}/notified\n")
        os.chmod(td / "notify.sh", 0o755)
        self.layout = {
            "port": self.port, "state_dir": str(self.state), "config": str(self.state / "openclaw.json"),
            "openclaw_root": str(live / "openclaw"), "node_dir": str(live / "node"),
            "candidate_openclaw": str(cand / "openclaw"), "candidate_node": str(cand / "node"),
            "cli": [sys.executable, str(fake)], "npm": [sys.executable, str(td / "fake-npm.py")],
            "start": [sys.executable, str(fake), "gateway", "--bind", "loopback", "--port", str(self.port)],
            "gateway_start_script": None, "gateway_log": str(td / "logs/gateway.log"),
            "compat_dir": str(td / "no-compat"), "compat_required": [],
            "receipts": str(td / "deploys"), "backups": str(td / "backups"), "lock": str(td / "deploys/companion-deploy.lock"),
            "foreign_locks": [], "pause_patterns": [r"fake-core-services-watchdog"], "companion": None,
            "gateway_pattern": r"fake-openclaw\.py gateway",
            "whatsapp_gate": True, "triage_stub_log": None, "notify": [str(td / "notify.sh")],
            "max_load": 1000, "min_available_mb": 0, "nice": 0,
            "heavy_jobs": "fake-heavy-job-" + str(os.getpid()),
            "budgets": {"stop_s": 5, "health_s": 15, "doctor_s": 30, "whatsapp_install_s": 30,
                        "whatsapp_connect_s": 10, "cli_s": 20, "companion_s": 5},
            "env": {"FAKE_ROOT": str(td), "OPENCLAW_STATE_DIR": str(self.state), "FAKE_SECRET": SECRET},
        }
        self.layout.update(overrides)
        self.layout_path = td / "layout.json"
        self.layout_path.write_text(json.dumps(self.layout))
        self.procs = []

    def make_db(self, rel, rows, wal=False, version=0):
        path = self.state / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(path)
        con.execute("PRAGMA journal_mode=WAL" if wal else "PRAGMA journal_mode=DELETE")
        con.execute(f"PRAGMA user_version={version}")
        con.execute("create table t(id integer primary key, v text)")
        con.executemany("insert into t(v) values (?)", [("row%d" % i,) for i in range(rows)])
        con.commit()
        con.close()

    def env(self, **extra):
        env = dict(os.environ, **self.layout["env"], **extra)
        return env

    def start_current_gateway(self):
        proc = subprocess.Popen(self.layout["start"], env=self.env(), stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True)
        self.procs.append(proc)
        for _ in range(100):
            if upgrade.http_status(f"http://127.0.0.1:{self.port}/health", 1) == 200:
                return
            time.sleep(0.05)
        raise AssertionError("fake gateway did not start")

    def watchdog(self):
        proc = subprocess.Popen(["bash", "-c", "exec -a fake-core-services-watchdog.sh sleep 120"],
                                start_new_session=True)
        self.procs.append(proc)
        time.sleep(0.2)
        return proc

    def run(self, *args, **env):
        return subprocess.run([sys.executable, str(SCRIPT), "--profile", "staging", "--layout", str(self.layout_path),
                               "--skip-prerequisite", "none", *args], env=self.env(**env), capture_output=True,
                              text=True, timeout=180)

    def receipt(self, run):
        return json.loads(Path(run.stdout.strip().splitlines()[-1]).read_text())

    def served_version(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as r:
            return r.read().decode()

    def cleanup(self):
        pid = upgrade.lease_gateway_pid(self.state)
        if pid:
            upgrade.kill_pids([pid], 3)
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()

    def all_text(self):
        texts = []
        for path in (self.td / "deploys").iterdir():
            if path.is_file() and path.suffix in (".json", ".log"):
                texts.append(path.read_text())
        return "\n".join(texts)


def db_rows(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return con.execute("select count(*) from t").fetchone()[0], con.execute("PRAGMA user_version").fetchone()[0]
    finally:
        con.close()


class OpenClawUpgrade(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = None

    def tearDown(self):
        if self.root:
            self.root.cleanup()
        self.tmp.cleanup()

    def make(self, **overrides):
        self.root = Root(Path(self.tmp.name), **overrides)
        return self.root

    def test_nominal_switch_deploys_and_keeps_rollback_copies(self):
        r = self.make()
        r.start_current_gateway()
        dog = r.watchdog()
        run = r.run(FAKE_WATCH_PID=str(dog.pid))
        doc = r.receipt(run)
        self.assertEqual(doc["state"], "deployed", json.dumps(doc, indent=1) + run.stderr)
        self.assertEqual(r.served_version(), "2026.10.9")
        self.assertEqual(upgrade.openclaw_version(Path(r.layout["openclaw_root"])), "2026.10.9")
        self.assertEqual(upgrade.node_version(Path(r.layout["node_dir"])), "24.22.2")
        self.assertEqual(len(list((r.td / "live").glob("openclaw.rollback-2026.9.6-*"))), 1)
        self.assertEqual(len(list((r.td / "live").glob("node.rollback-*"))), 1)
        # The watchdog was frozen during the window and runs again afterwards.
        self.assertEqual((r.td / "watch-state-during-doctor").read_text(), "T")
        self.assertNotEqual(upgrade.proc_stat(dog.pid), None)
        state = Path(f"/proc/{dog.pid}/stat").read_text()
        self.assertNotEqual(state[state.rindex(")") + 2], "T")
        for name in upgrade.GATES:
            self.assertTrue(doc["gates"][name]["ok"], name)
        self.assertEqual(doc["gates"]["plugin_tools"]["tools"], 42)
        self.assertEqual(doc["whatsapp"], {"from": "2026.9.6", "to": "2026.10.9"})
        self.assertEqual(len(list((r.state / "npm/projects").iterdir())), 1)
        peer = r.state / "npm/projects" / WA_GEN / "node_modules/@openclaw/whatsapp/node_modules/openclaw"
        self.assertTrue(peer.is_symlink())
        self.assertEqual(os.readlink(peer), r.layout["openclaw_root"])
        self.assertTrue(doc["phases"]["stage"]["whatsapp_candidate"]["peer_link_kept"])
        self.assertEqual(doc["gates"]["whatsapp"]["plugin_version"], "2026.10.9")
        self.assertEqual(doc["phases"]["doctor"]["migrated"], 2)
        agents = {d["path"]: d for d in doc["databases"]}
        self.assertEqual(len(agents), 4)
        self.assertTrue(all(d["backup_integrity"] for d in doc["databases"]))
        main = agents["agents/main/agent/openclaw-agent.sqlite"]
        self.assertEqual((main["schema_before"]["user_version"], main["schema_after"]["user_version"]), (23, 25))
        self.assertIsInstance(doc["downtime_ms"], int)
        for phase in ("preflight", "stage", "stop", "backup", "integrity", "switch", "doctor", "whatsapp", "consent", "start"):
            self.assertTrue(doc["phases"][phase]["ok"], phase)
        text = r.all_text()
        self.assertNotIn(SECRET, text)
        self.assertNotIn("+21600000000", text)
        self.assertEqual(run.returncode, 0)

    def test_forced_gate_failure_restores_everything_and_old_runtime_answers(self):
        r = self.make()
        r.start_current_gateway()
        before = {p: (r.state / p).read_bytes() for p in ("openclaw.json", "credentials/whatsapp/creds.json")}
        rows_before = db_rows(r.state / "agents/main/agent/openclaw-agent.sqlite")
        run = r.run("--force-gate-failure", "agent_turn")
        doc = r.receipt(run)
        self.assertEqual(doc["state"], "rolled_back", json.dumps(doc, indent=1))
        self.assertEqual(run.returncode, 6)
        self.assertTrue(doc["gates"]["agent_turn"].get("forced"))
        self.assertEqual(r.served_version(), "2026.9.6")
        self.assertEqual(upgrade.openclaw_version(Path(r.layout["openclaw_root"])), "2026.9.6")
        self.assertEqual(upgrade.node_version(Path(r.layout["node_dir"])), "24.21.0")
        for rel, data in before.items():
            self.assertEqual((r.state / rel).read_bytes(), data, rel)
        self.assertEqual(db_rows(r.state / "agents/main/agent/openclaw-agent.sqlite"), rows_before)
        self.assertEqual(db_rows(r.state / "state/openclaw.sqlite")[0], 2000)
        self.assertTrue(all(d["restored_sha_ok"] for d in doc["databases"]))
        rb = doc["rollback"]
        self.assertTrue(all(g["ok"] for g in rb["gates"].values()), rb)
        self.assertTrue(doc["phases"]["rollback_integrity"]["ok"])
        self.assertEqual(doc["phases"]["rollback_integrity"]["failed"], [])
        self.assertIsInstance(rb["downtime_ms"], int)
        self.assertEqual(upgrade.package_version(r.state / "npm/projects" / WA_GEN / "node_modules/@openclaw/whatsapp/package.json"), "2026.9.6")
        self.assertEqual(len(list((r.state / "npm/projects").iterdir())), 1)
        self.assertNotIn(SECRET, r.all_text())
        self.assertFalse((r.td / "notified").exists())

    def test_missing_consent_fails_the_tool_gate_and_rolls_back(self):
        r = self.make(consent_plugins=[])
        r.start_current_gateway()
        doc = r.receipt(r.run())
        self.assertEqual(doc["state"], "rolled_back")
        self.assertEqual(doc["gates"]["plugin_tools"]["tools"], 0)
        self.assertIn("plugin_tools", doc["failure"])

    def test_whatsapp_candidate_failure_stops_nothing(self):
        r = self.make()
        r.start_current_gateway()
        run = r.run(FAKE_NPM_FAIL="1")
        doc = r.receipt(run)
        self.assertEqual((doc["state"], run.returncode), ("failed", 5))
        self.assertIn("whatsapp_candidate_failed", doc["detail"])
        self.assertNotIn("stop", doc["phases"])
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_sigterm_during_doctor_still_rolls_back(self):
        r = self.make()
        r.start_current_gateway()
        proc = subprocess.Popen([sys.executable, str(SCRIPT), "--profile", "staging", "--layout", str(r.layout_path)],
                                env=r.env(FAKE_DOCTOR_SLEEP="30"), stdout=subprocess.PIPE, text=True)
        log = None
        for _ in range(300):
            logs = list((r.td / "deploys").glob("openclaw-upgrade-*[0-9].log")) if (r.td / "deploys").exists() else []
            if logs and '"phase": "doctor"' in logs[0].read_text():
                log = logs[0]
                break
            time.sleep(0.1)
        self.assertIsNotNone(log)
        proc.send_signal(15)
        out, _ = proc.communicate(timeout=120)
        doc = json.loads(Path(out.strip().splitlines()[-1]).read_text())
        self.assertEqual(doc["state"], "rolled_back")
        self.assertIn("interrupted", doc["failure"])
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_doctor_failure_rolls_back(self):
        r = self.make()
        r.start_current_gateway()
        doc = r.receipt(r.run(FAKE_DOCTOR_RC="1"))
        self.assertEqual(doc["state"], "rolled_back")
        self.assertIn("doctor_failed", doc["failure"])
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_gateway_that_never_answers_rolls_back(self):
        r = self.make()
        r.start_current_gateway()
        doc = r.receipt(r.run(FAKE_GATEWAY_DOWN_ON="2026.10.9"))
        self.assertEqual(doc["state"], "rolled_back")
        self.assertFalse(doc["gates"]["health_http"]["ok"])
        self.assertNotIn("agent_turn", doc["gates"])
        self.assertIn("gateway_exited", doc["gates"]["health_http"]["detail"])
        self.assertTrue(doc["gates"]["no_triage"]["ok"])
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_startup_failure_with_automatic_triage_is_recorded(self):
        r = self.make()
        r.start_current_gateway()
        doc = r.receipt(r.run(FAKE_GATEWAY_DOWN_ON="2026.10.9", FAKE_TRIAGE="1"))
        self.assertEqual(doc["state"], "rolled_back")
        self.assertFalse(doc["gates"]["no_triage"]["ok"])
        self.assertGreaterEqual(doc["gates"]["no_triage"]["log_hits"], 1)
        self.assertTrue(doc["rollback"]["gates"]["no_triage"]["ok"])
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_unhealthy_rollback_is_reported_and_notified(self):
        r = self.make()
        r.start_current_gateway()
        doc = r.receipt(r.run(FAKE_TURN_FAIL_ON="all"))
        self.assertEqual(doc["state"], "rollback_failed")
        self.assertIn("human_required", "human_required " + (r.td / "notified").read_text())

    def test_lock_busy_refuses_without_touching_the_gateway(self):
        import fcntl
        r = self.make()
        r.start_current_gateway()
        lock = Path(r.layout["lock"]); lock.parent.mkdir(parents=True, exist_ok=True)
        with open(lock, "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            run = r.run()
        doc = r.receipt(run)
        self.assertEqual((doc["state"], run.returncode), ("refused", 4))
        self.assertIn("deploy_already_running", doc["detail"])
        self.assertEqual(r.served_version(), "2026.9.6")
        self.assertFalse(Path(r.layout["openclaw_root"] + ".upgrade-candidate").exists())

    def test_disk_and_prerequisites_refuse_before_any_change(self):
        r = self.make(disk_factor=10 ** 9)
        r.start_current_gateway()
        doc = r.receipt(r.run())
        self.assertEqual(doc["state"], "refused")
        self.assertIn("disk_insufficient", doc["detail"])
        (r.state / "extensions/openclaw-plugin-mobile-ui/dist/companion/openclawSdkVersions.js").write_text('{"2026.9.6":1}')
        layout = json.loads(r.layout_path.read_text()); layout["disk_factor"] = 3
        script = r.td / "gateway-start.sh"; script.write_text("exec openclaw gateway\n")
        layout["gateway_start_script"] = str(script)
        r.layout_path.write_text(json.dumps(layout))
        doc = r.receipt(r.run())
        self.assertEqual(doc["state"], "refused")
        self.assertIn("plugin_sdk_target", doc["detail"])
        self.assertIn("triage_guard", doc["detail"])
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_heavy_job_refuses(self):
        r = self.make()
        r.start_current_gateway()
        job = subprocess.Popen(["bash", "-c", f"exec -a {r.layout['heavy_jobs']} sleep 30"], start_new_session=True)
        r.procs.append(job)
        time.sleep(0.2)
        doc = r.receipt(r.run())
        self.assertEqual((doc["state"], doc["detail"]), ("refused", "heavy_job_running"))
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_load_too_high_refuses_after_bounded_calm_wait(self):
        r = self.make(max_load=-1)
        r.start_current_gateway()
        started = time.monotonic()
        doc = r.receipt(r.run("--wait-calm", "10"))
        self.assertEqual(doc["state"], "refused")
        self.assertIn("load_too_high", doc["detail"])
        self.assertEqual(doc["phases"]["preflight"]["calm_wait_s"], 10)
        self.assertLess(time.monotonic() - started, 60)
        self.assertEqual(r.served_version(), "2026.9.6")

    def test_dry_run_and_status(self):
        r = self.make()
        r.start_current_gateway()
        run = r.run("--dry-run")
        self.assertEqual(r.receipt(run)["state"], "dry_run_ok")
        self.assertEqual(r.served_version(), "2026.9.6")
        status = subprocess.run([sys.executable, str(SCRIPT), "--profile", "staging", "--layout", str(r.layout_path),
                                 "--status"], capture_output=True, text=True, env=r.env())
        self.assertEqual(json.loads(status.stdout)["state"], "dry_run_ok")

    def test_wrapper_detaches_and_the_receipt_follows(self):
        r = self.make()
        r.start_current_gateway()
        run = subprocess.run(["bash", str(HERE / "openclaw-upgrade.sh"), "--profile", "staging", "--layout",
                              str(r.layout_path), "--dry-run", "--detach"], capture_output=True, text=True,
                             env=r.env(), timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        stamp = run.stdout.split("stamp=")[1].split()[0]
        receipt = r.td / "deploys" / f"openclaw-upgrade-{stamp}.json"
        for _ in range(200):
            if receipt.exists() and json.loads(receipt.read_text())["state"] != "in_progress":
                break
            time.sleep(0.1)
        self.assertEqual(json.loads(receipt.read_text())["state"], "dry_run_ok")

    def test_prod_refuses_forced_failure(self):
        run = subprocess.run([sys.executable, str(SCRIPT), "--profile", "prod", "--force-gate-failure", "agent_turn"],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)


FIXTURE = HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-11-01-openclaw-upgrade-1009/receipts.json"
KNOWN_PHASES = {"preflight", "stage", "stop", "backup", "integrity", "switch", "doctor", "whatsapp", "consent", "companion_restart",
                "start", "rollback_stop", "rollback_restore", "rollback_start", "rollback_integrity"}


class RealReceipts(unittest.TestCase):
    """Receipts written by this script on the S24 preprod rehearsal (fresh full-size copies of the prod bases)."""

    def setUp(self):
        self.doc = json.loads(FIXTURE.read_text())
        self.receipts = self.doc["receipts"]

    def test_schema_and_no_secret(self):
        text = FIXTURE.read_text()
        self.assertEqual(upgrade.redact(text), text)  # nothing token-like, no phone number
        for receipt in self.receipts:
            self.assertEqual((receipt["kind"], receipt["version"]), ("openclaw-upgrade", upgrade.RECEIPT_VERSION))
            self.assertLessEqual(set(receipt["phases"]), KNOWN_PHASES)
            self.assertLessEqual(set(receipt["gates"]), set(upgrade.GATES))
            self.assertEqual(receipt["from"], {"openclaw": "2026.9.6", "node": "24.21.0"})
            self.assertEqual(receipt["to"], {"openclaw": "2026.10.9", "node": "24.22.2"})
            self.assertEqual(len(receipt["databases"]), 20)
            self.assertTrue(all(d["backup_integrity"] for d in receipt["databases"]))

    def test_doctor_migrates_every_agent_database(self):
        for receipt in self.receipts:
            agents = [d for d in receipt["databases"] if d["path"].endswith("agent/openclaw-agent.sqlite")]
            self.assertEqual(len(agents), 7)
            for d in agents:
                self.assertEqual((d["schema_before"]["user_version"], d["schema_after"]["user_version"]), (23, 25))
            state = next(d for d in receipt["databases"] if d["path"] == "state/openclaw.sqlite")
            self.assertGreater(state["bytes"], 100_000_000)

    def test_every_rollback_restored_identical_bytes_and_answered(self):
        rolled = [r for r in self.receipts if r["state"] == "rolled_back"]
        self.assertGreaterEqual(len(rolled), 2)
        for receipt in rolled:
            self.assertTrue(all(d["restored_sha_ok"] for d in receipt["databases"]))
            gates = receipt["rollback"]["gates"]
            for name in ("health_http", "health_json", "agent_turn", "no_triage"):
                self.assertTrue(gates[name]["ok"], name)
            self.assertEqual(receipt["phases"]["rollback_integrity"]["failed"], [])
            self.assertEqual(receipt["phases"]["rollback_restore"]["openclaw"], "2026.9.6")

    def test_nominal_receipt_passed_every_gate(self):
        deployed = [r for r in self.receipts if r["state"] == "deployed"]
        self.assertEqual(len(deployed), 1)
        receipt = deployed[0]
        for name in upgrade.GATES:
            self.assertTrue(receipt["gates"][name]["ok"], name)
        self.assertEqual(receipt["whatsapp"], {"from": "2026.9.6", "to": "2026.10.9"})
        self.assertIsInstance(receipt["downtime_ms"], int)


class Units(unittest.TestCase):
    def test_backup_reads_rows_still_in_the_wal(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "live.sqlite"
            con = sqlite3.connect(db)
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA wal_autocheckpoint=0")
            con.execute("create table t(v)")
            con.executemany("insert into t values (?)", [(i,) for i in range(1000)])
            con.commit()  # rows only in -wal, connection kept open
            self.assertGreater(Path(str(db) + "-wal").stat().st_size, 0)
            copy = Path(td) / "b/copy.sqlite"
            upgrade.sqlite_backup(db, copy)
            con.close()
            check = sqlite3.connect(copy)
            self.assertEqual(check.execute("select count(*) from t").fetchone()[0], 1000)
            check.close()
            self.assertTrue(upgrade.integrity(copy))
            self.assertFalse(Path(str(copy) + "-wal").exists())

    def test_inventory_and_redaction(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            for rel in ("state/openclaw.sqlite", "state/openclaw.sqlite-wal", "state/openclaw.sqlite.pre-x",
                        "agents/a/agent/openclaw-agent.sqlite", "headless-state2/state/openclaw.sqlite",
                        "agents/a/agent/openclaw-agent.sqlite.abc.bak"):
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_bytes(b"x")
            found = [str(p.relative_to(root)) for p in upgrade.inventory(root)]
            self.assertEqual(found, ["state/openclaw.sqlite", "agents/a/agent/openclaw-agent.sqlite",
                                     "headless-state2/state/openclaw.sqlite"])
        text = upgrade.redact('token="abc" key ' + "A" * 40 + " +216 22 333 444 auth=Bearer xyz")
        self.assertNotIn("abc", text)
        self.assertNotIn("A" * 40, text)
        self.assertNotIn("22 333 444", text)
        self.assertNotIn("xyz", text)

    def test_prod_layout_paths(self):
        layout = upgrade.load_layout("prod", None, {"HOME": "/h", "PREFIX": "/p"})
        self.assertEqual(layout["openclaw_root"], "/p/lib/node_modules/openclaw")
        self.assertEqual(layout["lock"], "/h/.openclaw/deploys/companion-deploy.lock")
        self.assertEqual(layout["port"], 18789)
        self.assertTrue(layout["whatsapp_gate"])
        staging = upgrade.load_layout("staging", None, {"HOME": "/h", "PREFIX": "/p"})
        self.assertEqual(staging["env"]["OPENCLAW_SKIP_CHANNELS"], "1")
        self.assertEqual(staging["env"]["OPENCLAW_SKIP_CRON"], "1")
        self.assertIn("/h/.openclaw/deploys/companion-deploy.lock", staging["foreign_locks"])
        self.assertNotIn("/h/.openclaw/", staging["state_dir"] + "/")


if __name__ == "__main__":
    unittest.main()
