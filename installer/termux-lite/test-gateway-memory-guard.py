#!/data/data/com.termux/files/usr/bin/python3
"""P0-4 : seuils RSS mesurés, redémarrage gracieux seulement au repos, au plus une fois par
6 h, avec reçu. Captures réelles : s24-2026-10-10/p0-4-5, s24-2026-10-11b/p0-4-5b et
s24-2026-10-11c/p0-4-5 (sources de repos)."""
import fcntl, importlib.util, json, os, sqlite3, subprocess, sys, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
FIX = HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures"
spec = importlib.util.spec_from_file_location("gateway_memory_guard", HERE / "gateway-memory-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
policy = guard.policy
T = policy.MEASURED_THRESHOLDS
RSS = json.loads((FIX / "s24-2026-10-11b/p0-4-5b/rss-current-and-history.json").read_text())
INV = json.loads((FIX / "s24-2026-10-10/p0-4-5/resources-inventory.json").read_text())
IDLE = json.loads((FIX / "s24-2026-10-11c/p0-4-5/idle-sources.json").read_text())
MIB = 1024


def m(rss_mib, swap_mib=600, avail_mib=2400, load=6.13):
    return policy.Metrics(int(rss_mib * MIB), int(swap_mib * MIB), int(avail_mib * MIB), load)


def dead_pid():
    out = subprocess.run([sys.executable, "-c", "import os;print(os.getpid())"], text=True, capture_output=True).stdout
    return int(out)


def build_oc(root, now, *, extra_task=None, live_confirmation=False, bridge_live=False):
    oc = Path(root)
    (oc / "state").mkdir(parents=True)
    con = sqlite3.connect(oc / "state/openclaw.sqlite")
    con.execute("create table task_runs(task_id text, status text)")
    con.execute("create table cron_run_receipts(receipt_id text, status text, finished_at_ms int)")
    for status, n in IDLE["openclaw_sqlite"]["task_runs"]["counts"].items():
        con.executemany("insert into task_runs values(?,?)", [(f"{status}{i}", status) for i in range(min(n, 5))])
    for status, n in IDLE["openclaw_sqlite"]["cron_run_receipts"]["counts"].items():
        con.executemany("insert into cron_run_receipts values(?,?,1)", [(f"{status}{i}", status) for i in range(min(n, 5))])
    if extra_task:
        con.execute("insert into task_runs values('live', ?)", (extra_task,))
    con.commit(); con.close()
    reg = IDLE["companion_runs_json"]
    runs = [{"runId": f"{s}{i}", "state": s} for s, n in reg["runs_state_counts"].items() for i in range(n)]

    def rows(items):
        out = []
        for item in items:
            if "expiresAgeHours" in item:
                out.append({"state": item["state"], "expiresAt": int((now - item["expiresAgeHours"] * 3600) * 1000)})
            else:
                out.extend({"state": item["state"], "expiresAt": int((now - 3600) * 1000)} for _ in range(item["n"]))
        return out
    confirmations = rows(reg["ownerConfirmations"])
    if live_confirmation:
        confirmations.append({"state": "awaiting_owner", "expiresAt": int((now + 120) * 1000)})
    (oc / "clawmobile-companion").mkdir()
    (oc / "clawmobile-companion/runs.json").write_text(json.dumps({"version": 1, "runs": runs,
        "paymentRequests": rows(reg["paymentRequests"]), "ownerConfirmations": confirmations}))
    req = oc / "remote-bridge/requests"; req.mkdir(parents=True)
    for i in range(16):  # the 16 stuck receipts of dead instances (capture f6)
        (req / f"stuck-{i}.json").write_text(json.dumps({"requestId": f"stuck-{i}", "state": "running", "instanceId": f"{dead_pid()}-1-abcdef01"}))
    for i in range(200):
        (req / f"done-{i}.json").write_text(json.dumps({"requestId": f"done-{i}", "state": "completed", "instanceId": "1-1-00000000"}))
    if bridge_live:
        (req / "live.json").write_text(json.dumps({"requestId": "live", "state": "running", "instanceId": f"{os.getpid()}-1-abcdef01"}))
    (oc / "deploys").mkdir()
    return oc


class Thresholds(unittest.TestCase):
    def test_measured_thresholds_above_every_real_observation(self):
        events = RSS["history"]["gatewayNativePressureLog"]["events"]
        bundles = RSS["history"]["gatewayStabilitySnapshots"]["rows"]
        gw = RSS["current"]["gateway"]
        peaks = [e["rssBytes"] // 1024 for e in events] + [b["maxRssBytes"] // 1024 for b in bundles] + [gw["VmHWM_kB"], gw["VmRSS_kB"]]
        self.assertEqual(len(events), 15)
        self.assertLess(max(peaks), T.rss_kib)
        self.assertLess(T.rss_kib, policy.NATIVE_RSS_CRITICAL_KIB)
        self.assertGreater(T.rss_kib, policy.NATIVE_RSS_WARNING_KIB, "la Gateway dépasse déjà l'avertissement natif en permanence")
        swaps = [gw["VmSwap_kB"], int(INV["gateway"]["procStatus"]["VmSwap"].split()[0])]
        self.assertLess(max(swaps), T.swap_kib)
        self.assertGreater(RSS["current"]["meminfo_kB"]["MemAvailable"], T.available_kib)
        self.assertEqual(T.sustained_seconds, 600)
        self.assertEqual(policy.RESTART_COOLDOWN_SECONDS, 6 * 3600)

    def test_no_real_sample_triggers_a_restart(self):
        gw = RSS["current"]["gateway"]
        for e in RSS["history"]["gatewayNativePressureLog"]["events"]:
            sample = policy.Metrics(e["rssBytes"] // 1024, gw["VmSwap_kB"], RSS["current"]["meminfo_kB"]["MemAvailable"], 6.13)
            self.assertEqual(policy.restart_reasons(sample, T), [], e["at"])
        real = policy.metrics_from_owner_observation(INV["gateway"]["procStatus"], INV["meminfo"], INV["uptime"])
        self.assertEqual(policy.restart_reasons(real, T), [])

    def test_load_alone_and_low_memory_with_small_gateway_never_restart(self):
        self.assertEqual(policy.restart_reasons(m(1800, load=9.5), T), [])
        self.assertEqual(policy.restart_reasons(m(1400, avail_mib=900), T), [])
        self.assertEqual(policy.restart_reasons(m(1700, avail_mib=900), T), ["memory_available"])
        self.assertEqual(policy.restart_reasons(m(2700), T), ["gateway_rss"])
        self.assertEqual(policy.restart_reasons(m(1800, swap_mib=1600), T), ["gateway_swap"])


class Evaluate(unittest.TestCase):
    def run_seq(self, steps, idle=None, healthy=lambda: True):
        prev = {"version": 1, "last_attempt": {"at": 0, "state": "none"}}
        calls = []

        def idle_fn(now):
            calls.append(now)
            return idle if idle is not None else ({k: 0 for k in ("gateway_tasks", "cron_runs", "companion_runs", "remote_bridge", "deploy", "heavy_job", "payments", "confirmations")}, None)
        rows = []
        for now, metrics, pid in steps:
            prev = guard.evaluate(now, prev, metrics, pid, idle_fn, healthy)
            rows.append(prev)
        return rows, calls

    def test_sustained_then_idle_then_receipt_and_cooldown(self):
        t0 = 1_000_000
        rows, calls = self.run_seq([(t0, m(2700), 100), (t0 + 300, m(2700), 100), (t0 + 600, m(2700), 100),
                                    (t0 + 700, m(2700), 200), (t0 + 3 * 3600, m(2700), 200), (t0 + 600 + 6 * 3600, m(2700), 200)])
        self.assertEqual([r["action"] for r in rows], ["none", "none", "restart_requested", "none", "none", "restart_requested"])
        self.assertEqual(rows[0]["decision"]["reason"], "pressure_not_sustained")
        self.assertEqual(rows[2]["last_attempt"], {"at": t0 + 600, "state": "requested", "gateway_pid": 100, "reasons": ["gateway_rss"]})
        self.assertEqual(rows[3]["last_attempt"]["state"], "completed", "nouveau pid et healthz : redémarrage constaté, sans rejeu")
        self.assertEqual(rows[4]["decision"]["reason"], "restart_cooldown")
        self.assertEqual(len(calls), 2, "la preuve de repos n'est lue que si tout le reste l'autorise")
        self.assertEqual(rows[2]["idle"]["complete"], True)

    def test_pressure_gap_resets_sustain(self):
        t0 = 2_000_000
        rows, _ = self.run_seq([(t0, m(2700), 1), (t0 + 400, m(1800), 1), (t0 + 700, m(2700), 1), (t0 + 1200, m(2700), 1)])
        self.assertEqual(rows[1]["pressure"]["since"], None)
        self.assertEqual(rows[3]["decision"]["reason"], "pressure_not_sustained")

    def test_failed_or_uncertain_attempt_counts_for_six_hours(self):
        t0 = 3_000_000
        rows, _ = self.run_seq([(t0, m(2700), 7), (t0 + 600, m(2700), 7), (t0 + 1300, m(2700), 7), (t0 + 2 * 3600, m(2700), 7)], healthy=lambda: False)
        self.assertEqual(rows[1]["action"], "restart_requested")
        self.assertEqual(rows[2]["last_attempt"]["state"], "uncertain")
        self.assertEqual(rows[3]["decision"]["reason"], "restart_cooldown")

    def test_busy_or_unknown_idle_refuses(self):
        t0 = 4_000_000
        busy = {k: 0 for k in ("gateway_tasks", "cron_runs", "companion_runs", "remote_bridge", "deploy", "heavy_job", "payments", "confirmations")}
        for key, reason in (("gateway_tasks", "runtime_busy_or_unknown"), ("payments", "runtime_busy_or_unknown"),
                            ("confirmations", "runtime_busy_or_unknown"), ("deploy", "runtime_busy_or_unknown")):
            rows, _ = self.run_seq([(t0, m(2700), 1), (t0 + 600, m(2700), 1)], idle=({**busy, key: 1}, None))
            self.assertEqual(rows[1]["decision"]["reason"], reason, key)
            self.assertEqual(rows[1]["last_attempt"]["state"], "none")
        rows, _ = self.run_seq([(t0, m(2700), 1), (t0 + 600, m(2700), 1)], idle=(None, "companion_registry_unreadable"))
        self.assertEqual(rows[1]["decision"]["reason"], "idle_unproven")
        self.assertEqual(rows[1]["idle"], {"complete": False, "reason": "companion_registry_unreadable"})

    def test_unknown_metrics_never_restart(self):
        rows, _ = self.run_seq([(5_000_000, policy.Metrics(None, 1, 1, 1.0), None), (5_000_700, policy.Metrics(None, 1, 1, 1.0), None)])
        self.assertTrue(all(r["action"] == "none" for r in rows))


class IdleProofOnCapture(unittest.TestCase):
    def test_capture_state_is_idle_despite_stale_bridge_and_expired_approvals(self):
        now = time.time()
        with tempfile.TemporaryDirectory() as td:
            oc = build_oc(td, now)
            busy, why = guard.idle_proof(now, oc)
            self.assertIsNone(why)
            self.assertEqual({k: v for k, v in busy.items() if k != "heavy_job"},
                             {"gateway_tasks": 0, "cron_runs": 0, "companion_runs": 0, "payments": 0,
                              "confirmations": 0, "remote_bridge": 0, "deploy": 0})

    def test_each_active_source_is_seen(self):
        now = time.time()
        for kwargs, key in (({"extra_task": "running"}, "gateway_tasks"), ({"live_confirmation": True}, "confirmations"),
                            ({"bridge_live": True}, "remote_bridge")):
            with tempfile.TemporaryDirectory() as td:
                busy, _ = guard.idle_proof(now, build_oc(td, now, **kwargs))
                self.assertEqual(busy[key], 1, key)

    def test_deploy_lock_and_unreadable_sources(self):
        now = time.time()
        with tempfile.TemporaryDirectory() as td:
            oc = build_oc(td, now)
            fd = os.open(oc / "deploys/companion-deploy.lock", os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                self.assertEqual(guard.idle_proof(now, oc)[0]["deploy"], 1)
            finally:
                os.close(fd)
            (oc / "clawmobile-companion/runs.json").write_text("{corrupt")
            self.assertEqual(guard.idle_proof(now, oc), (None, "companion_registry_unreadable"))
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(guard.idle_proof(now, Path(td)), (None, "gateway_state_unreadable"))


class Main(unittest.TestCase):
    def test_corrupt_history_never_restarts_and_is_kept(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "gateway-memory-guard.json"; receipt.write_text("{bad")
            with patch.object(guard, "RECEIPT", receipt), patch("builtins.print") as out:
                guard.main([])
            self.assertIn("restart_history_unknown", out.call_args.args[0])
            self.assertEqual(receipt.read_text(), "{bad")

    def test_observe_only_switch_keeps_history(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "g.json"
            receipt.write_text(json.dumps({"version": 1, "pressure": {"since": time.time() - 700}, "last_attempt": {"at": 0, "state": "none"}}))
            ok = ({k: 0 for k in ("gateway_tasks", "cron_runs", "companion_runs", "remote_bridge", "deploy", "heavy_job", "payments", "confirmations")}, None)
            with patch.object(guard, "RECEIPT", receipt), patch.object(guard, "gateway_pid", return_value=9), \
                 patch.object(guard, "probe_metrics", return_value=m(2700)), patch.object(guard, "idle_proof", return_value=ok), \
                 patch.dict(os.environ, {"SAMANTHA_GATEWAY_MEMORY_RESTART": "0"}), patch("builtins.print") as out:
                guard.main([])
            self.assertIn("observe_only", out.call_args.args[0])
            row = json.loads(receipt.read_text())
            self.assertEqual(row["last_attempt"], {"at": 0, "state": "none"})
            self.assertEqual(oct(receipt.stat().st_mode & 0o777), "0o600")
            self.assertEqual(row["mode"], "observe")

    def _granted(self, env):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "g.json"
            receipt.write_text(json.dumps({"version": 1, "pressure": {"since": time.time() - 700}, "last_attempt": {"at": 0, "state": "none"}}))
            ok = ({k: 0 for k in ("gateway_tasks", "cron_runs", "companion_runs", "remote_bridge", "deploy", "heavy_job", "payments", "confirmations")}, None)
            clean = {k: v for k, v in os.environ.items() if k != "SAMANTHA_GATEWAY_MEMORY_RESTART"}
            with patch.object(guard, "RECEIPT", receipt), patch.object(guard, "gateway_pid", return_value=9), \
                 patch.object(guard, "probe_metrics", return_value=m(2700)), patch.object(guard, "idle_proof", return_value=ok), \
                 patch.dict(os.environ, {**clean, **env}, clear=True), patch("builtins.print") as out:
                guard.main([])
            return out.call_args.args[0], json.loads(receipt.read_text())

    def test_default_is_observation_only(self):
        printed, row = self._granted({})
        self.assertIn("observe_only", printed)
        self.assertNotIn("restart_requested", printed)
        self.assertEqual(row["mode"], "observe")
        self.assertEqual(row["last_attempt"], {"at": 0, "state": "none"})

    def test_explicit_switch_requests_restart(self):
        printed, row = self._granted({"SAMANTHA_GATEWAY_MEMORY_RESTART": "1"})
        self.assertIn('"action": "restart_requested"', printed)
        self.assertEqual(row["mode"], "restart")
        self.assertEqual(row["last_attempt"]["state"], "requested")

    def test_health_manager_wiring(self):
        hm = (HERE / "samantha-health-manager.sh").read_text()
        self.assertIn('check_gateway_memory\n', hm.split("while :; do")[-1])
        body = hm.split("check_gateway_memory(){", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("put gateway_memory next $(( $(now)+60 ))", body)
        self.assertIn("http://127.0.0.1:8765/v1/runtime/restart", body)
        self.assertIn('"action": "restart_requested"', body)
        self.assertIn("bounded-log.py", body)


if __name__ == "__main__":
    unittest.main()
