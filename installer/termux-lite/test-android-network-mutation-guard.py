#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import io
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

MODULE = Path(__file__).with_name("android-network-mutation-guard.py")
spec = importlib.util.spec_from_file_location("guard", MODULE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

def blank():
    return {k: {"exists": False, "value": None} for k in guard.KEYS}

def on_auto_wifi():
    return {k: {"exists": True, "value": "1"} for k in guard.AUTO_WIFI_KEYS}

FIXTURES_11 = MODULE.parents[2] / "openclaw-plugin-mobile-ui" / "fixtures" / "s24-2026-10-11" / "android"
CONNECTIVITY_CELLULAR = (FIXTURES_11 / "dumpsys-connectivity-cellular-default.txt").read_text()
# Same real shape with the default network on Wi-Fi (no capture possible without mutating the S24 network).
CONNECTIVITY_WIFI = (CONNECTIVITY_CELLULAR.replace("Active default network: 127", "Active default network: 130")
    .replace("network{127}", "network{130}").replace("ni{MOBILE[LTE] CONNECTED extra: weborange}", "ni{WIFI CONNECTED extra: }")
    .replace("Transports: CELLULAR", "Transports: WIFI"))
CONNECTIVITY_NONE = CONNECTIVITY_CELLULAR.split("Active default network:")[0] + "Active default network: none\n"

class FakeAndroidSettings:
    """Simulated `settings global` + Wi-Fi radio + default network. No real ADB, no real network toggle."""
    def __init__(self, auto_wifi=None, wifi=True, wifi_samples=None, connected=None):
        self.globals = {} if auto_wifi is None else dict(auto_wifi)
        self.wifi = wifi
        self.connected = wifi if connected is None else connected
        self.wifi_samples = list(wifi_samples or [])
        self.calls = []
    def adb(self, *args, **kwargs):
        self.calls.append(args)
        class P: returncode=0; stdout=""; stderr=""
        out = P()
        if args[:4] == ("shell","settings","list","global"):
            out.stdout = "".join(f"{k}={v}\n" for k, v in self.globals.items())
        elif args[:4] == ("shell","settings","put","global"):
            self.globals[args[4]] = args[5]
        elif args[:4] == ("shell","settings","delete","global"):
            self.globals.pop(args[4], None)
        elif args[:3] == ("shell","svc","wifi"):
            self.wifi = args[3] == "enable"
        elif args[:4] == ("shell","cmd","wifi","status"):
            if self.wifi_samples:
                self.wifi = self.wifi_samples.pop(0)
            out.stdout = "Wifi is enabled\n" if self.wifi else "Wifi is disabled\n"
            if self.wifi:
                out.stdout += 'Wifi is connected to "home"\n' if self.connected else "Wifi is not connected\n"
        elif args[:3] == ("shell","dumpsys","connectivity"):
            out.stdout = CONNECTIVITY_WIFI if (self.wifi and self.connected) else CONNECTIVITY_CELLULAR
        return out
    def toggles(self):
        return [c for c in self.calls if c[:3] == ("shell","svc","wifi")]

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "receipt.json"
        self.side = [patch.object(guard, "spawn_restorer", return_value=True), patch.object(guard, "log_line")]
        for p in self.side:
            p.start()

    def tearDown(self):
        for p in self.side:
            p.stop()
        guard.ROOT, guard.LEASES, guard.RECEIPT = self.old
        self.tmp.cleanup()

    def test_restore_absent_keys_uses_delete_not_literal_null(self):
        expected = blank()
        current = {k: {"exists": True, "value": "sentinel"} for k in guard.KEYS}
        calls = []
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard, "adb", side_effect=fake_adb), patch.object(guard, "settings_state", side_effect=[current, expected]):
            guard.restore_state(expected)
        deletes = [c for c in calls if c[:4] == ("shell","settings","delete","global")]
        puts = [c for c in calls if c[:4] == ("shell","settings","put","global")]
        self.assertEqual(len(deletes), len(guard.KEYS))
        self.assertEqual(puts, [])

    def test_restore_existing_sentinel_is_exact(self):
        expected = blank()
        expected["http_proxy"] = {"exists": True, "value": ":0"}
        current = blank()
        calls = []
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard, "adb", side_effect=fake_adb), patch.object(guard, "settings_state", side_effect=[current, expected]):
            guard.restore_state(expected)
        self.assertEqual(calls, [("shell","settings","put","global","http_proxy",":0")])

    def test_restore_identical_empty_proxy_sentinels_is_noop(self):
        expected = blank()
        expected["http_proxy"] = {"exists": True, "value": ":0"}
        expected["global_http_proxy_host"] = {"exists": True, "value": ""}
        expected["global_http_proxy_port"] = {"exists": True, "value": "0"}
        expected["global_http_proxy_exclusion_list"] = {"exists": True, "value": ""}
        expected["global_proxy_pac_url"] = {"exists": True, "value": ""}
        with patch.object(guard, "adb") as adb, patch.object(guard, "settings_state", return_value=expected):
            guard.restore_state(expected)
        adb.assert_not_called()
        self.assertFalse(guard.proxy_active(expected))

    def test_restore_changed_empty_existing_value_fails_closed(self):
        expected = blank()
        expected["global_http_proxy_host"] = {"exists": True, "value": ""}
        current = blank()
        with patch.object(guard, "adb") as adb, patch.object(guard, "settings_state", return_value=current):
            with self.assertRaisesRegex(RuntimeError, "empty_network_setting_restore_unsupported"):
                guard.restore_state(expected)
        adb.assert_not_called()

    def test_stale_owned_lease_is_restored_and_removed(self):
        guard.LEASES.mkdir(parents=True)
        lease = guard.LEASES / "stale.json"
        lease.write_text(json.dumps({"created_at": 1, "owner_pid": 999999, "settings": blank()}))
        with patch.object(guard, "lease_alive", return_value=False),              patch.object(guard, "restore_state") as restore,              patch.object(guard, "settings_state", return_value=blank()):
            rc = guard.check_and_reconcile(False)
        self.assertEqual(rc, 0)
        restore.assert_called_once()
        self.assertFalse(lease.exists())
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual(receipt["reason"], "stale_lease_restored")

    def test_unmanaged_proxy_is_detected_not_cleared(self):
        state = blank()
        state["global_http_proxy_host"] = {"exists": True, "value": "127.0.0.1"}
        state["global_http_proxy_port"] = {"exists": True, "value": "8888"}
        with patch.object(guard, "settings_state", return_value=state),              patch.object(guard, "restore_state") as restore:
            rc = guard.check_and_reconcile(False)
        self.assertEqual(rc, 2)
        restore.assert_not_called()
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual(receipt["reason"], "unmanaged_global_proxy_detected")

    def test_active_owned_lease_is_not_reconciled(self):
        guard.LEASES.mkdir(parents=True)
        lease = guard.LEASES / "active.json"
        lease.write_text(json.dumps({"created_at": 9999999999, "owner_pid": 1, "settings": blank()}))
        active_state = blank()
        active_state["http_proxy"] = {"exists": True, "value": "127.0.0.1:8888"}
        with patch.object(guard, "lease_alive", return_value=True),              patch.object(guard, "settings_state", return_value=active_state),              patch.object(guard, "restore_state") as restore:
            rc = guard.check_and_reconcile(False)
        self.assertEqual(rc, 0)
        restore.assert_not_called()
        self.assertTrue(lease.exists())
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual(receipt["reason"], "temporary_lease_active")


    def test_termux_background_repair_is_bounded_and_verified(self):
        bad = {
            "healthy": False,
            "packages": {
                "com.termux": {"uid":10554,"doze_whitelisted":False,"run_any_in_background":False,
                                "run_in_background":False,"inactive":True,"standby_bucket":40,
                                "hibernation_supported":True,"hibernated":True,"healthy":False}
            },
            "data_saver_whitelisted": {"10554": False},
        }
        good = {
            "healthy": True,
            "packages": {
                "com.termux": {"uid":10554,"doze_whitelisted":True,"run_any_in_background":True,
                                "run_in_background":True,"inactive":False,"standby_bucket":5,
                                "hibernation_supported":True,"hibernated":False,"healthy":True}
            },
            "data_saver_whitelisted": {"10554": True},
        }
        calls=[]
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard,"termux_background_state",side_effect=[bad,good]), patch.object(guard,"adb",side_effect=fake_adb):
            out=guard.ensure_termux_background_network()
        self.assertEqual(out["mutation"],"repaired")
        self.assertIn(("shell","dumpsys","deviceidle","whitelist","+com.termux"),calls)
        self.assertIn(("shell","cmd","appops","set","com.termux","RUN_ANY_IN_BACKGROUND","allow"),calls)
        self.assertIn(("shell","cmd","appops","set","com.termux","RUN_IN_BACKGROUND","allow"),calls)
        self.assertIn(("shell","am","set-inactive","com.termux","false"),calls)
        self.assertIn(("shell","am","set-standby-bucket","com.termux","active"),calls)
        self.assertIn(("shell","cmd","app_hibernation","set-state","com.termux","false"),calls)
        self.assertIn(("shell","cmd","netpolicy","add","restrict-background-whitelist","10554"),calls)

    def test_termux_background_healthy_state_has_no_mutation(self):
        good={"healthy":True,"packages":{},"data_saver_whitelisted":{}}
        with patch.object(guard,"termux_background_state",return_value=good), patch.object(guard,"repair_termux_background") as repair:
            out=guard.ensure_termux_background_network()
        self.assertEqual(out["mutation"],"none"); repair.assert_not_called()

    def test_wifi_state_parser(self):
        class P: returncode=0
        with patch.object(guard,"adb") as adb:
            P.stdout="Wi-Fi is enabled\n"; adb.return_value=P(); self.assertTrue(guard.wifi_enabled())
            P.stdout="Wi-Fi is disabled\n"; adb.return_value=P(); self.assertFalse(guard.wifi_enabled())

    def test_wifi_lease_restores_initial_enabled_state(self):
        row={"type":"wifi_off","settings":blank(),"wifi_enabled":True}
        with patch.object(guard,"restore_state"), patch.object(guard,"wifi_enabled",side_effect=[False,True]), patch.object(guard,"set_wifi") as set_wifi:
            guard.restore_lease(row)
        set_wifi.assert_called_once_with(True)

    def test_with_wifi_off_restores_even_after_child(self):
        guard.LEASES.mkdir(parents=True,exist_ok=True)
        lease=guard.LEASES/"wifi.json"
        def create(*_a, **_k):
            lease.write_text(json.dumps({"type":"wifi_off","created_at":1,"owner_pid":1,"purpose":"test","settings":blank(),"wifi_enabled":True,"auto_wifi":on_auto_wifi()}))
            return lease
        with patch.object(guard,"create_lease",side_effect=create), patch.object(guard,"set_wifi") as set_wifi, \
             patch.object(guard,"wifi_toggle_decision",return_value={"toggle":True,"detail":"wifi_default","wifi_enabled":True}), \
             patch.object(guard,"disable_auto_wifi") as disable, patch.object(guard,"restore_lease") as restore, \
             patch.object(guard,"run_while_wifi_stays_off",return_value=(0,False)):
            rc=guard.with_wifi_off("test",["echo","ok"])
        self.assertEqual(rc,0)
        disable.assert_called_once_with(on_auto_wifi())
        set_wifi.assert_called_once_with(False)
        restore.assert_called_once()
        self.assertFalse(lease.exists())

    def test_active_wifi_lease_does_not_hide_unmanaged_proxy(self):
        guard.LEASES.mkdir(parents=True,exist_ok=True)
        lease=guard.LEASES/"wifi-active.json"
        lease.write_text(json.dumps({"type":"wifi_off","created_at":9999999999,"owner_pid":1,"purpose":"test","settings":blank(),"wifi_enabled":True}))
        state=blank(); state["http_proxy"]={"exists":True,"value":"127.0.0.1:8888"}
        with patch.object(guard,"lease_alive",return_value=True), patch.object(guard,"settings_state",return_value=state), patch.object(guard,"restore_lease") as restore:
            rc=guard.check_and_reconcile(False)
        self.assertEqual(rc,2); restore.assert_not_called()
        self.assertEqual(json.loads(guard.RECEIPT.read_text())["reason"],"unmanaged_global_proxy_detected")

    def test_stale_wifi_lease_is_restored_exactly(self):
        guard.LEASES.mkdir(parents=True,exist_ok=True)
        lease=guard.LEASES/"wifi-stale.json"
        lease.write_text(json.dumps({"type":"wifi_off","created_at":1,"owner_pid":999999,"purpose":"test","settings":blank(),"wifi_enabled":False}))
        with patch.object(guard,"lease_alive",return_value=False), patch.object(guard,"restore_lease") as restore, patch.object(guard,"settings_state",return_value=blank()):
            rc=guard.check_and_reconcile(False)
        self.assertEqual(rc,0); restore.assert_called_once()
        self.assertFalse(lease.exists())

class AutoWifiTests(unittest.TestCase):
    """P0-7 (11/10): Auto Wi-Fi is snapshotted in the lease, forced to 0, restored exactly; a Wi-Fi return blocks."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "receipt.json"
        self.side = [patch.object(guard, "spawn_restorer", return_value=True), patch.object(guard, "log_line")]
        for p in self.side:
            p.start()

    def tearDown(self):
        for p in self.side:
            p.stop()
        guard.ROOT, guard.LEASES, guard.RECEIPT = self.old
        self.tmp.cleanup()

    def run_guarded(self, fake, child_result=(0, False)):
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
             patch.object(guard, "run_while_wifi_stays_off", return_value=child_result) as child, \
             patch("sys.stdout", new_callable=io.StringIO) as out:
            rc = guard.with_wifi_off("test", ["true"])
        return rc, child, out.getvalue()

    def test_lease_snapshots_auto_wifi_and_restores_exactly(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        seen = {}
        def during(_command, **_kwargs):
            seen["globals"] = dict(fake.globals); seen["wifi"] = fake.wifi
            lease = next(guard.LEASES.glob("*.json"))
            seen["lease"] = json.loads(lease.read_text())
            return 0, False
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
             patch.object(guard, "run_while_wifi_stays_off", side_effect=during):
            self.assertEqual(guard.with_wifi_off("test", ["true"]), 0)
        self.assertEqual(seen["lease"]["auto_wifi"], on_auto_wifi())
        self.assertEqual(seen["globals"], {"auto_wifi": "0", "sem_auto_wifi_control_enabled": "0"})
        self.assertFalse(seen["wifi"])
        self.assertEqual(fake.globals, {"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"})
        self.assertTrue(fake.wifi)
        self.assertEqual(list(guard.LEASES.glob("*.json")), [])
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["state"], receipt["auto_wifi_restored"]), ("healthy", True))

    def test_absent_auto_wifi_key_is_deleted_not_written(self):
        fake = FakeAndroidSettings({"auto_wifi": "1"}, wifi=True)
        rc, _, _ = self.run_guarded(fake)
        self.assertEqual(rc, 0)
        self.assertEqual(fake.globals, {"auto_wifi": "1"})
        self.assertIn(("shell","settings","delete","global","sem_auto_wifi_control_enabled"), fake.calls)
        self.assertFalse(any("null" in c for c in fake.calls))
        self.assertTrue(fake.wifi)

    def test_restore_happens_on_child_failure_and_interrupt(self):
        for effect in (RuntimeError("child_failed"), KeyboardInterrupt()):
            fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
            with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
                 patch.object(guard, "run_while_wifi_stays_off", side_effect=effect):
                with self.assertRaises(type(effect)):
                    guard.with_wifi_off("test", ["true"])
            self.assertEqual(fake.globals, {"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"})
            self.assertTrue(fake.wifi)
            self.assertEqual(list(guard.LEASES.glob("*.json")), [])

    def test_wifi_reenabled_prints_blocked_and_still_restores(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        rc, _, out = self.run_guarded(fake, child_result=(guard.WIFI_REENABLED_EXIT, True))
        self.assertEqual(rc, guard.WIFI_REENABLED_EXIT)
        self.assertEqual(json.loads(out.strip().splitlines()[-1]),
                         {"schemaVersion": 1, "state": "blocked", "reasonCode": "wifi_reenabled"})
        self.assertEqual(fake.globals, {"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"})
        self.assertTrue(json.loads(guard.RECEIPT.read_text())["wifi_reenabled_during_operation"])

    def test_watch_stops_child_when_wifi_returns(self):
        child = MagicMock(); child.poll.side_effect = [None, None, None, -15, -15]
        sleeps = []
        with patch.object(guard.subprocess, "Popen", return_value=child), \
             patch.object(guard, "wifi_enabled", side_effect=[False, True]):
            code, back = guard.run_while_wifi_stays_off(["sleep", "10"], sleep=sleeps.append)
        self.assertEqual((code, back), (guard.WIFI_REENABLED_EXIT, True))
        child.terminate.assert_called_once()
        self.assertEqual(sleeps, [guard.WIFI_WATCH_INTERVAL_S])
        self.assertEqual(guard.WIFI_WATCH_INTERVAL_S, 0.5)

    def test_watch_ignores_unreadable_sample_and_returns_child_code(self):
        child = MagicMock(); child.poll.side_effect = [None, None, 0, 0]
        with patch.object(guard.subprocess, "Popen", return_value=child), \
             patch.object(guard, "wifi_enabled", side_effect=[RuntimeError("wifi_state_unknown"), False]):
            self.assertEqual(guard.run_while_wifi_stays_off(["true"], sleep=lambda _s: None), (0, False))
        child.terminate.assert_not_called()

    def test_stale_lease_restores_auto_wifi(self):
        fake = FakeAndroidSettings({"auto_wifi": "0", "sem_auto_wifi_control_enabled": "0"}, wifi=False)
        row = {"type": "wifi_off", "settings": blank(), "wifi_enabled": True, "auto_wifi": on_auto_wifi()}
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            guard.restore_lease(row)
        self.assertEqual(fake.globals, {"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"})
        self.assertTrue(fake.wifi)

    def test_real_s24_capture_parses_auto_wifi_proxy_and_wifi_state(self):
        fixtures = MODULE.parents[2] / "openclaw-plugin-mobile-ui" / "fixtures" / "s24-2026-10-10" / "android"
        settings = (fixtures / "settings-global-network.txt").read_text()
        status = (fixtures / "cmd-wifi-status.txt").read_text()
        def fake_adb(*args, **kwargs):
            class P: returncode=0; stderr=""
            P.stdout = settings if args[:3] == ("shell","settings","list") else status
            return P()
        with patch.object(guard, "adb", side_effect=fake_adb):
            self.assertEqual(guard.auto_wifi_state(), on_auto_wifi())
            self.assertTrue(guard.wifi_enabled())
            state = guard.settings_state()
        self.assertEqual(state["http_proxy"], {"exists": True, "value": ":0"})
        self.assertFalse(guard.proxy_active(state))

    def test_legacy_lease_without_auto_wifi_touches_nothing(self):
        fake = FakeAndroidSettings({"auto_wifi": "0"}, wifi=True)
        with patch.object(guard, "adb", side_effect=fake.adb):
            guard.restore_lease({"type": "wifi_off", "settings": blank(), "wifi_enabled": True})
        self.assertEqual(fake.globals, {"auto_wifi": "0"})

class WifiRestorerTests(unittest.TestCase):
    """Incident S24 11/10 16:00 : la restauration du Wi-Fi ne dépend plus de la survie du garde."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "receipt.json"
        self.spawned = []
        self.side = [patch.object(guard, "spawn_restorer", side_effect=lambda lease, token: self.spawned.append((lease, token)) or True),
                     patch.object(guard, "log_line")]
        self.log = None
        for p in self.side:
            started = p.start()
            if p is self.side[1]:
                self.log = started

    def tearDown(self):
        for p in self.side:
            p.stop()
        guard.ROOT, guard.LEASES, guard.RECEIPT = self.old
        self.tmp.cleanup()

    def guard_cut_wifi(self, fake, purpose="maxit-topup-payment"):
        """Lease exactly as with-wifi-off writes it, then the cut it performs (Auto Wi-Fi 0, Wi-Fi off)."""
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            lease = guard.create_lease(purpose, lease_type="wifi_off", include_wifi=True,
                                       ttl_s=guard.wifi_off_ttl(purpose), decision={"detail": "wifi_default"})
            row = json.loads(lease.read_text())
            guard.disable_auto_wifi(row["auto_wifi"])
            if row["wifi_enabled"]:
                guard.set_wifi(False)
        return lease, row

    def test_lease_is_durable_bounded_and_carries_owner_contract(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        lease, row = self.guard_cut_wifi(fake)
        self.assertEqual(oct(lease.stat().st_mode & 0o777), "0o600")
        for key in ("purpose", "owner_pid", "created_at", "ttl_s", "expires_at", "wifi_enabled", "owner_token", "auto_wifi"):
            self.assertIn(key, row)
        self.assertEqual((row["purpose"], row["owner_pid"], row["wifi_enabled"], row["ttl_s"]), ("maxit-topup-payment", os.getpid(), True, 120))
        self.assertAlmostEqual(row["expires_at"] - row["created_at"], 120)
        self.assertEqual(list(guard.LEASES.glob(".lease-*")), [])  # atomic write, no temp left

    def test_ttl_is_bounded(self):
        self.assertEqual(guard.wifi_off_ttl("maxit-topup-payment"), 120)
        self.assertEqual(guard.wifi_off_ttl("maxit-deterministic"), 120)
        self.assertEqual(guard.wifi_off_ttl("unknown-purpose"), 120)
        with patch.dict(guard.PURPOSE_BUDGET_S, {"long": 10_000}):
            self.assertEqual(guard.wifi_off_ttl("long"), guard.WIFI_OFF_MAX_TTL_S)

    def test_killed_guard_is_restored_by_detached_restorer(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        lease, row = self.guard_cut_wifi(fake)
        victim = subprocess.Popen(["sleep", "30"])  # stands for the guard process
        row.update(owner_pid=victim.pid, owner_identity=guard.process_identity(victim.pid))
        guard.write_json(lease, row)
        sleeps = []
        def sleep(s):
            sleeps.append(s)
            if len(sleeps) == 1:
                victim.kill(); victim.wait()  # SIGKILL while Wi-Fi is off (bridge timeout)
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            result = guard.run_restorer(lease, row["owner_token"], sleep=sleep)
        self.assertEqual(result, "restored")
        self.assertTrue(fake.wifi)
        self.assertEqual(fake.globals, {"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"})
        self.assertFalse(lease.exists())
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["reason"], receipt["cause"]), ("wifi_lease_restored_by_restorer", "owner_dead"))
        self.assertIn("wifi_lease_restored_by_restorer", self.log.call_args[0][0])
        self.assertEqual(sleeps, [guard.RESTORER_POLL_S])

    def test_killed_unreaped_guard_counts_as_dead(self):
        victim = subprocess.Popen(["sleep", "30"])
        row = {"type": "wifi_off", "owner_pid": victim.pid, "owner_identity": guard.process_identity(victim.pid)}
        self.assertTrue(guard.lease_alive(row))
        victim.kill()
        import time as _time
        for _ in range(50):
            if not guard.lease_alive(row):
                break
            _time.sleep(0.02)
        self.assertFalse(guard.lease_alive(row))  # zombie: killed, parent has not reaped it yet
        victim.wait()
        self.assertFalse(guard.lease_alive(row))

    def test_restorer_restores_at_ttl_even_if_guard_hangs(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        lease, row = self.guard_cut_wifi(fake)
        calls = []
        def clock():
            calls.append(1)
            return row["created_at"] + 10 if len(calls) <= 2 else row["expires_at"] + 1
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            result = guard.run_restorer(lease, row["owner_token"], clock=clock, sleep=lambda _s: None)
        self.assertEqual(result, "restored")
        self.assertTrue(fake.wifi)
        self.assertEqual(json.loads(guard.RECEIPT.read_text())["cause"], "ttl_expired")

    def test_normal_exit_restores_once_and_restorer_does_nothing(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
             patch.object(guard, "run_while_wifi_stays_off", return_value=(0, False)) as child:
            self.assertEqual(guard.with_wifi_off("maxit-topup-payment", ["true"]), 0)
            lease, token = self.spawned[0]
            self.assertEqual(guard.run_restorer(lease, token, sleep=lambda _s: self.fail("must not wait")), "lease_released")
        self.assertEqual(fake.toggles(), [("shell","svc","wifi","disable"), ("shell","svc","wifi","enable")])
        self.assertTrue(fake.wifi)
        self.assertGreater(child.call_args.kwargs["deadline_s"], 60)  # provider budget (60 s) fits
        self.assertLessEqual(child.call_args.kwargs["deadline_s"], 120 - guard.RESTORE_MARGIN_S)
        self.assertEqual(json.loads(guard.RECEIPT.read_text())["restored_by"], "guard")

    def test_restorer_first_then_guard_exit_is_not_a_double_toggle(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        def child(_command, **_kwargs):
            lease, token = self.spawned[0]
            row = json.loads(lease.read_text())
            far = row["expires_at"] + 5
            self.assertEqual(guard.run_restorer(lease, token, clock=lambda: far, sleep=lambda _s: None), "restored")
            return guard.WIFI_REENABLED_EXIT, True
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
             patch.object(guard, "run_while_wifi_stays_off", side_effect=child), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(guard.with_wifi_off("maxit-topup-payment", ["true"]), guard.WIFI_REENABLED_EXIT)
        self.assertEqual(fake.toggles(), [("shell","svc","wifi","disable"), ("shell","svc","wifi","enable")])
        self.assertEqual(json.loads(guard.RECEIPT.read_text())["restored_by"], "restorer_or_sweep")

    def test_previous_state_off_never_turns_wifi_on(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=False)
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            lease = guard.create_lease("maxit-topup-payment", lease_type="wifi_off", include_wifi=True, ttl_s=120)
            row = json.loads(lease.read_text())
            self.assertFalse(row["wifi_enabled"])
            with patch.object(guard, "lease_alive", return_value=False):
                self.assertEqual(guard.run_restorer(lease, row["owner_token"], sleep=lambda _s: None), "restored")
                lease2 = guard.create_lease("maxit-topup-payment", lease_type="wifi_off", include_wifi=True, ttl_s=120)
                self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertFalse(lease2.exists())
        self.assertFalse(fake.wifi)
        self.assertNotIn(("shell","svc","wifi","enable"), fake.calls)

    def test_concurrent_guard_refuses_while_a_live_wifi_lease_exists(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        first, _row = self.guard_cut_wifi(fake)  # live owner (this pid), within TTL: Wi-Fi is off now
        fake.calls.clear()
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
             patch("sys.stdout", new_callable=io.StringIO) as out, patch.object(guard.subprocess, "run") as run:
            rc = guard.with_wifi_off("maxit-deterministic", ["true"])
        self.assertEqual(rc, guard.WIFI_GUARD_BUSY_EXIT)
        self.assertEqual(json.loads(out.getvalue().strip().splitlines()[-1])["reasonCode"], "wifi_off_guard_busy")
        self.assertEqual(fake.calls, [])  # no snapshot of the other guard's "off", no toggle
        self.assertEqual(sorted(guard.LEASES.glob("*.json")), [first])
        run.assert_not_called()

    def test_concurrent_guard_honors_held_guard_lock(self):
        guard.ROOT.mkdir(parents=True, exist_ok=True)
        fd = os.open(guard.ROOT / "guard.lock", os.O_CREAT | os.O_RDWR, 0o600)
        guard.fcntl.flock(fd, guard.fcntl.LOCK_EX)
        ticks = iter(range(0, 10_000, 3))
        try:
            with patch.object(guard, "adb") as adb, patch.object(guard.time, "sleep"), \
                 patch.object(guard.time, "monotonic", side_effect=lambda: next(ticks)):
                with self.assertRaisesRegex(RuntimeError, "network_mutation_guard_busy"):
                    guard.with_wifi_off("maxit-deterministic", ["true"])
            adb.assert_not_called()
        finally:
            os.close(fd)

    def test_sweep_restores_stale_lease_and_logs_receipt_line(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        lease, row = self.guard_cut_wifi(fake)
        row["expires_at"] = time_now() - 1  # TTL expired, owner (this pid) still alive
        guard.write_json(lease, row)
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertFalse(lease.exists())
        self.assertTrue(fake.wifi)
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["reason"], receipt["recovered_leases"], receipt["warnings"]), ("stale_lease_restored", [lease.name], []))
        line = self.log.call_args[0][0]
        self.assertIn("action=stale_lease_restored", line); self.assertIn("cause=ttl_expired", line)

    def test_sweep_warns_on_wifi_off_without_lease_and_never_enables(self):
        fake = FakeAndroidSettings({"auto_wifi": "1"}, wifi=False)
        with patch.object(guard, "adb", side_effect=fake.adb):
            self.assertEqual(guard.check_and_reconcile(False), 0)
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["state"], receipt["warnings"]), ("healthy", [guard.WIFI_UNMANAGED_WARNING]))
        self.assertEqual(fake.toggles(), [])

    def test_spawned_restorer_is_detached_from_guard_and_bridge(self):
        self.side[0].stop()
        try:
            proc = MagicMock(); proc.wait.return_value = 0
            with patch.object(guard.subprocess, "Popen", return_value=proc) as popen:
                self.assertTrue(guard.spawn_restorer(guard.LEASES / ("a" * 32 + ".json"), "tok"))
            argv, kwargs = popen.call_args
            self.assertEqual(argv[0][2:4], ["wifi-restorer", str(guard.LEASES / ("a" * 32 + ".json"))])
            self.assertTrue(kwargs["start_new_session"]); self.assertTrue(kwargs["close_fds"])
            self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
        finally:
            self.side[0].start()

    def test_restorer_unavailable_means_no_wifi_cut(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        with patch.object(guard, "spawn_restorer", return_value=False), patch.object(guard, "adb", side_effect=fake.adb), \
             patch.object(guard.time, "sleep"), patch("sys.stdout", new_callable=io.StringIO) as out:
            self.assertEqual(guard.with_wifi_off("maxit-topup-payment", ["true"]), guard.WIFI_RESTORER_UNAVAILABLE_EXIT)
        self.assertEqual(fake.toggles(), [])
        self.assertEqual(list(guard.LEASES.glob("*.json")), [])
        self.assertIn("wifi_restorer_unavailable", out.getvalue())

    def test_watch_stops_child_at_lease_deadline(self):
        child = MagicMock(); child.poll.side_effect = [None, None, None, None, -15, -15]
        ticks = iter([0, 0, 50, 101, 101, 101])
        with patch.object(guard.subprocess, "Popen", return_value=child), patch.object(guard, "wifi_enabled", return_value=False):
            code, back = guard.run_while_wifi_stays_off(["sleep", "999"], sleep=lambda _s: None,
                                                        deadline_s=100, clock=lambda: next(ticks))
        self.assertEqual((code, back), (guard.WIFI_TTL_EXIT, False))
        child.terminate.assert_called_once()

    def test_restorer_rejects_paths_outside_the_lease_directory(self):
        guard.LEASES.mkdir(parents=True)
        for bad in ("/tmp/" + "a" * 32 + ".json", str(guard.LEASES / "x.json")):
            with self.assertRaises(ValueError):
                guard.wifi_lease_path(bad)
        self.assertEqual(guard.wifi_lease_path(str(guard.LEASES / ("b" * 32 + ".json"))).name, "b" * 32 + ".json")

FAKE_ADB = """#!/usr/bin/env python3
import json, os, sys
state_path = os.environ["FAKE_ADB_STATE"]
st = json.load(open(state_path))
a = sys.argv[1:]
if a[:1] == ["-s"]:
    a = a[2:]
out = ""
if a[:4] == ["shell", "settings", "list", "global"]:
    out = "".join(f"{k}={v}\\n" for k, v in st["globals"].items())
elif a[:4] == ["shell", "settings", "put", "global"]:
    st["globals"][a[4]] = a[5]
elif a[:4] == ["shell", "settings", "delete", "global"]:
    st["globals"].pop(a[4], None)
elif a[:3] == ["shell", "svc", "wifi"]:
    st["wifi"] = a[3] == "enable"; st["toggles"].append(a[3])
elif a[:4] == ["shell", "cmd", "wifi", "status"]:
    out = "Wifi is enabled\\n" if st["wifi"] else "Wifi is disabled\\n"
json.dump(st, open(state_path, "w"))
sys.stdout.write(out)
"""

class DetachedRestorerProcessTest(unittest.TestCase):
    """Real process: `wifi-restorer` detaches (setsid + double fork) and restores from the lease alone."""
    def test_real_detached_restorer_restores_after_guard_death(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp); bindir = home / "bin"; bindir.mkdir()
            (bindir / "adb").write_text(FAKE_ADB); (bindir / "adb").chmod(0o755)
            state = home / "adb-state.json"
            state.write_text(json.dumps({"globals": {"auto_wifi": "0", "sem_auto_wifi_control_enabled": "0"}, "wifi": False, "toggles": []}))
            leases = home / ".openclaw" / "network-mutation" / "leases"; leases.mkdir(parents=True)
            dead = subprocess.Popen(["true"]); dead.wait()
            token = "c" * 32
            lease = leases / ("d" * 32 + ".json")
            lease.write_text(json.dumps({"schema_version": 2, "type": "wifi_off", "created_at": 1, "owner_pid": dead.pid,
                                         "purpose": "maxit-topup-payment", "settings": blank(), "wifi_enabled": True,
                                         "auto_wifi": on_auto_wifi(), "owner_token": token, "ttl_s": 120,
                                         "expires_at": 9_999_999_999}))
            env = dict(os.environ, HOME=str(home), PATH=f"{bindir}:{os.environ['PATH']}", FAKE_ADB_STATE=str(state))
            import sys as _sys
            started = subprocess.run([_sys.executable, str(MODULE), "wifi-restorer", str(lease), "--token", token],
                                     env=env, timeout=10)
            self.assertEqual(started.returncode, 0)  # intermediate returns at once; restorer lives on detached
            import time as _time
            deadline = _time.monotonic() + 20
            while lease.exists() and _time.monotonic() < deadline:
                _time.sleep(0.1)
            self.assertFalse(lease.exists())
            def restorer_running():
                for proc in Path("/proc").iterdir():
                    try:
                        if proc.name.isdigit() and token.encode() in (proc / "cmdline").read_bytes():
                            return True
                    except OSError:
                        pass
                return False
            while restorer_running() and _time.monotonic() < deadline:
                _time.sleep(0.05)
            self.assertFalse(restorer_running())  # short-lived: exits after restoring
            self.assertIn("wifi_lease_restored_by_restorer", (home / ".openclaw" / "health" / "health.log").read_text())
            final = json.loads(state.read_text())
            self.assertTrue(final["wifi"])
            self.assertEqual(final["toggles"], ["enable"])
            self.assertEqual(final["globals"], {"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"})
            receipt = json.loads((home / ".openclaw" / "health" / "network-mutation-safety.json").read_text())
            self.assertEqual(receipt["reason"], "wifi_lease_restored_by_restorer")

class HealthManagerSweepContractTest(unittest.TestCase):
    def test_sweep_runs_check_then_only_warns_on_unleased_wifi_off(self):
        script = MODULE.with_name("samantha-health-manager.sh").read_text()
        fn = script[script.index("check_network_safety(){"):script.index("check_android_phantom_headroom(){")]
        self.assertIn("android-network-mutation-guard.py\" check", fn)
        self.assertIn("network_wifi_warning", fn)
        self.assertIn("wifi_disabled_without_lease", fn)
        self.assertNotIn("svc wifi", script)  # the Health Manager never toggles Wi-Fi by itself

class CellularDefaultTests(unittest.TestCase):
    """Demande d'Amine (11/10, en 4G) : ne couper le Wi-Fi que s'il est le réseau par défaut connecté."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "receipt.json"
        self.side = [patch.object(guard, "spawn_restorer", return_value=True), patch.object(guard, "log_line")]
        for p in self.side:
            p.start()

    def tearDown(self):
        for p in self.side:
            p.stop()
        guard.ROOT, guard.LEASES, guard.RECEIPT = self.old
        self.tmp.cleanup()

    def run_guard(self, fake):
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
             patch.object(guard, "run_while_wifi_stays_off", return_value=(0, False)) as watch, \
             patch.object(guard.subprocess, "run", return_value=subprocess.CompletedProcess(["true"], 0)) as direct:
            rc = guard.with_wifi_off("maxit-topup-payment", ["true"])
        return rc, watch, direct

    def test_real_s24_capture_cellular_default_validated(self):
        self.assertEqual(guard.parse_default_network(CONNECTIVITY_CELLULAR), {"transport": "cellular", "validated": True})
        self.assertEqual(guard.parse_default_network(CONNECTIVITY_WIFI)["transport"], "wifi")
        self.assertEqual(guard.parse_default_network(CONNECTIVITY_NONE)["transport"], "none")
        self.assertEqual(guard.parse_default_network("garbage")["transport"], "unknown")
        status = (FIXTURES_11 / "cmd-wifi-status-enabled-not-connected.txt").read_text()
        class P: returncode=0; stderr=""; stdout=status
        with patch.object(guard, "adb", return_value=P()):
            self.assertTrue(guard.wifi_enabled()); self.assertFalse(guard.wifi_connected())

    def test_wifi_disabled_no_toggle(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=False)
        rc, watch, direct = self.run_guard(fake)
        self.assertEqual(rc, 0)
        self.assertEqual(fake.toggles(), [])
        self.assertFalse(any(c[:4] == ("shell","settings","put","global") for c in fake.calls))
        self.assertEqual(list(guard.LEASES.glob("*.json")), [])
        watch.assert_called_once()  # still blocks if Wi-Fi comes back mid-run
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["mutation"], receipt["reason"], receipt["network_decision"]), ("none", "cellular_already_default", "wifi_disabled"))

    def test_wifi_enabled_but_disconnected_no_toggle(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True, connected=False)
        rc, watch, direct = self.run_guard(fake)
        self.assertEqual(rc, 0)
        self.assertEqual(fake.toggles(), [])
        self.assertFalse(any(c[:4] == ("shell","settings","put","global") for c in fake.calls))
        direct.assert_called_once_with(["true"]); watch.assert_not_called()
        self.assertEqual(list(guard.LEASES.glob("*.json")), [])
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["mutation"], receipt["reason"], receipt["network_decision"]),
                         ("none", "cellular_already_default", "cellular_default_validated"))
        self.assertTrue(fake.wifi)

    def test_wifi_connected_default_toggles_and_restores(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True, connected=True)
        rc, watch, direct = self.run_guard(fake)
        self.assertEqual(rc, 0)
        self.assertEqual(fake.toggles(), [("shell","svc","wifi","disable"), ("shell","svc","wifi","enable")])
        self.assertTrue(fake.wifi)
        self.assertEqual(fake.globals, {"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"})
        watch.assert_called_once(); direct.assert_not_called()
        receipt = json.loads(guard.RECEIPT.read_text())
        self.assertEqual((receipt["mutation"], receipt["network_decision"]), ("wifi_off", "wifi_default"))

    def test_unknown_default_falls_back_to_explicit_wifi_connection(self):
        with patch.object(guard, "wifi_enabled", return_value=True), \
             patch.object(guard, "default_network", side_effect=RuntimeError("adb_command_failed")), \
             patch.object(guard, "wifi_connected", return_value=False):
            self.assertFalse(guard.wifi_toggle_decision()["toggle"])
        with patch.object(guard, "wifi_enabled", return_value=True), \
             patch.object(guard, "default_network", return_value={"transport": "other", "validated": True}), \
             patch.object(guard, "wifi_connected", return_value=True):
            self.assertTrue(guard.wifi_toggle_decision()["toggle"])

def time_now():
    import time
    return time.time()

class FakeAdb:
    """Protocol fixture only. No subprocess, real ADB, proxy or UI is used."""
    def __init__(self, testcase):
        self.testcase = testcase
        self.rows = []
        self.calls = []
        self.create_behavior = None
        self.remove_behavior = None
        self.fail_lists = False
        self.fail_after_create = False

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs.get("serial")))
        if args == ("forward", "--list"):
            if self.fail_lists:
                raise RuntimeError("fixture_observation_unavailable")
            return subprocess.CompletedProcess(args, 0, "\n".join(" ".join(r[k] for k in ("serial", "local", "remote")) for r in self.rows), "")
        if args[:2] == ("forward", "--no-rebind"):
            local, remote = args[2:]
            leases = [json.loads(p.read_text()) for p in guard.LEASES.glob("*.json")]
            row = next(r for r in leases if r.get("resource", {}).get("local") == local)
            self.testcase.assertEqual(row["state"], "CREATE_REQUESTED")
            self.testcase.assertEqual(row["before"], [])
            self.testcase.assertEqual(row["events"][0]["state"], "PREPARED")
            self.testcase.assertTrue(row["mutation_dispatched"])
            self.testcase.assertFalse(row["ownership_proven"])
            self.testcase.assert_lock_held()
            if any(r["local"] == local for r in self.rows):
                return subprocess.CompletedProcess(args, 1, "", "fixture: cannot rebind")
            self.rows.append({"serial": kwargs["serial"], "local": local, "remote": remote})
            if local.startswith("localfilesystem:"):
                unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    unix.bind(local.split(":", 1)[1])
                finally:
                    unix.close()
            if self.create_behavior == "timeout":
                raise subprocess.TimeoutExpired("fixture-adb", 1)
            if self.create_behavior == "crash":
                raise KeyboardInterrupt("fixture crash after effect before acknowledgment")
            if self.create_behavior == "nonzero_effect":
                return subprocess.CompletedProcess(args, 1, "", "fixture explicit failure after effect")
            if self.fail_after_create:
                self.fail_lists = True
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[:2] == ("forward", "--remove"):
            local = args[2]
            row = next(json.loads(p.read_text()) for p in guard.LEASES.glob("*.json")
                       if json.loads(p.read_text()).get("resource", {}).get("local") == local)
            self.testcase.assertEqual(row["state"], "REMOVE_REQUESTED")
            self.testcase.assertTrue(row["remove_dispatched"])
            self.testcase.assert_lock_held()
            if self.remove_behavior == "timeout_keep":
                raise subprocess.TimeoutExpired("fixture-adb", 1)
            # Real ADB removal is local-only: the guard must check every identity.
            self.rows = [r for r in self.rows if r["local"] != local]
            if self.remove_behavior == "timeout_removed":
                raise subprocess.TimeoutExpired("fixture-adb", 1)
            return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError("unexpected fixture ADB command")

    def mutations(self):
        return [args for args, _ in self.calls if args[:2] in (("forward", "--no-rebind"), ("forward", "--remove"))]

class ForwardLeaseTests(unittest.TestCase):
    SERIAL = "fixture-device"
    OWNER = 4242
    LEASE = "a" * 32
    REMOTE = "localabstract:fixture_chrome_devtools_remote"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "network-mutation"
        self.clock = 10000.0
        self.identities = {self.OWNER: {"start_ticks": "fixture-birth-1", "boot_id": "fixture-boot"}}
        self.unreadable = set()
        self.server = {"binary": "/fixture/adb", "ADB_SERVER_SOCKET": None}
        self.fake = FakeAdb(self)
        patches = {
            "ROOT": self.root, "LEASES": self.root / "leases", "RECEIPT": self.root / "health.json",
            "MAX_LEASE_AGE": 900, "adb": self.fake,
        }
        for name, value in patches.items():
            p = patch.object(guard, name, value); p.start(); self.addCleanup(p.stop)
        for name, function in (("process_identity", self.identity), ("forward_server_identity", lambda: dict(self.server)),
                               ("settings_state", blank)):
            p = patch.object(guard, name, side_effect=function); p.start(); self.addCleanup(p.stop)
        p = patch.object(guard.time, "time", side_effect=lambda: self.clock); p.start(); self.addCleanup(p.stop)
        p = patch.object(guard.os, "kill", side_effect=self.kill); p.start(); self.addCleanup(p.stop)

    def identity(self, pid):
        return None if pid in self.unreadable else self.identities.get(pid)

    def kill(self, pid, sig):
        if pid not in self.identities:
            raise ProcessLookupError("fixture owner absent")

    def assert_lock_held(self):
        fd = os.open(self.root / "guard.lock", os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):
                guard.fcntl.flock(fd, guard.fcntl.LOCK_EX | guard.fcntl.LOCK_NB)
        finally:
            os.close(fd)

    def acquire(self, **overrides):
        args = {"serial": self.SERIAL, "local": "tcp:49152", "remote": self.REMOTE,
                "purpose": "UNIT FIXTURE ONLY", "owner_pid": self.OWNER, "lease_id": self.LEASE}
        args.update(overrides)
        return guard.acquire_adb_forward(**args)

    def lease(self):
        return json.loads((guard.LEASES / (self.LEASE + ".json")).read_text())

    def end_owner(self):
        self.identities.pop(self.OWNER, None)

    def test_create_is_durable_once_and_cleanup_only_its_mapping(self):
        unrelated = {"serial": "other-device", "local": "tcp:49153", "remote": "tcp:8080"}
        self.fake.rows.append(unrelated)
        acquired = self.acquire()
        self.assertEqual(acquired["state"], "ACTIVE")
        self.assertTrue(acquired["ready"] and acquired["verified"])
        self.assertEqual(acquired["endpoint"], "http://127.0.0.1:49152")
        self.assertEqual((guard.LEASES / (self.LEASE + ".json")).stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.acquire()["ready"])
        self.assertEqual(len(self.fake.mutations()), 1)
        closed = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(closed["cleanup_verified"])
        self.assertTrue(closed["restored_exact"])
        self.assertFalse(closed["ready"])
        self.assertEqual(self.fake.rows, [unrelated])
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(len(self.fake.mutations()), 2)
        self.assertEqual(self.lease()["state"], "CLOSED")

    def test_preexisting_exact_forward_is_reused_and_never_removed(self):
        existing = {"serial": self.SERIAL, "local": "tcp:49152", "remote": self.REMOTE}
        self.fake.rows = [existing]
        result = self.acquire(local="tcp:0")
        self.assertEqual(result["state"], "REUSED")
        self.assertTrue(result["ready"])
        self.assertFalse(result["created"] or result["mutation_dispatched"])
        self.assertTrue(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        self.assertEqual(self.fake.rows, [existing])
        self.assertEqual(self.fake.mutations(), [])

    def test_preexisting_foreign_local_is_blocked_without_cleanup_debt(self):
        existing = {"serial": "other-device", "local": "tcp:49152", "remote": "tcp:8080"}
        self.fake.rows = [existing]
        result = self.acquire()
        self.assertEqual(result["state"], "BLOCKED")
        self.assertFalse(result["ready"] or result["mutation_dispatched"])
        self.assertTrue(result["cleanup_verified"])
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(self.fake.rows, [existing])
        self.assertEqual(self.fake.mutations(), [])

    def test_multiple_matching_preexisting_forwards_are_not_guessed(self):
        self.fake.rows = [{"serial": self.SERIAL, "local": f"tcp:{port}", "remote": self.REMOTE} for port in (49152, 49153)]
        result = self.acquire(local="tcp:0")
        self.assertEqual(result["state"], "BLOCKED")
        self.assertEqual(result["reason"], "multiple_preexisting_forwards")
        self.assertEqual(self.fake.mutations(), [])

    def test_dynamic_port_is_concrete_in_lease_before_dispatch(self):
        class Reservation:
            def bind(self, address): self.address = address
            def getsockname(self): return ("127.0.0.1", 49157)
            def close(self): pass
        with patch.object(guard.socket, "socket", return_value=Reservation()):
            result = self.acquire(local="tcp:0")
        self.assertTrue(result["ready"])
        self.assertEqual(result["local"], "tcp:49157")
        self.assertEqual(self.lease()["request"]["local"], "tcp:0")
        self.assertEqual(self.fake.mutations()[0][2], "tcp:49157")

    def test_unknown_create_with_matching_mapping_is_never_owned_or_replayed(self):
        self.fake.create_behavior = "timeout"
        result = self.acquire()
        self.assertEqual(result["state"], "VERIFY_REQUIRED")
        self.assertFalse(result["ready"] or result["created"])
        self.assertTrue(result["observed_matches"])
        self.acquire()
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 2)
        self.assertEqual(len(self.fake.mutations()), 1)
        self.assertEqual(len(self.fake.rows), 1)

    def test_crash_after_effect_before_ack_preserves_unproven_forward(self):
        self.fake.create_behavior = "crash"
        with self.assertRaises(KeyboardInterrupt):
            self.acquire()
        self.assertEqual(self.lease()["state"], "CREATE_REQUESTED")
        self.assertFalse(self.lease()["ownership_proven"])
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 2)
        self.assertEqual(len(self.fake.mutations()), 1)
        self.assertEqual(len(self.fake.rows), 1)

    def test_dead_owner_acknowledged_forward_is_reconciled(self):
        self.acquire()
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])
        self.assertTrue(self.lease()["cleanup_verified"])
        self.assertTrue((guard.LEASES / (self.LEASE + ".json")).exists())

    def test_acknowledged_create_with_lost_observation_can_be_cleaned_when_observed(self):
        self.fake.fail_after_create = True
        result = self.acquire()
        self.assertFalse(result["ready"])
        self.assertTrue(result["created"])
        self.fake.fail_lists = False
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])

    def test_repointed_mapping_is_preserved_even_if_old_tuple_later_returns(self):
        self.acquire()
        old = self.fake.rows[0]
        foreign = {**old, "serial": "other-device", "remote": "tcp:8080"}
        self.fake.rows = [foreign]
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(result["state"], "PRESERVED")
        self.assertFalse(result["cleanup_verified"])
        self.fake.rows = [old]
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(self.fake.rows, [old])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_observed_absence_revokes_ownership_before_same_tuple_reappears(self):
        self.acquire()
        old = self.fake.rows[0]
        self.fake.rows = []
        self.assertFalse(guard.inspect_adb_forward(self.LEASE)["ready"])
        self.assertTrue(self.lease()["ownership_lost"])
        self.fake.rows = [old]
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(self.fake.rows, [old])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_renewal_preserves_active_campaign_beyond_original_ttl(self):
        self.acquire()
        self.clock += 899
        result = guard.renew_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(result["ready"])
        self.clock += 200
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(len(self.fake.rows), 1)
        self.assertEqual(len(self.fake.mutations()), 1)
        self.assertEqual(self.lease()["renewals"], 1)
        self.clock += 701
        self.assertFalse(guard.renew_adb_forward(self.LEASE, self.OWNER)["ready"])
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])

    def test_observed_absence_after_lost_creation_observation_revokes_ownership(self):
        self.fake.fail_after_create = True
        result = self.acquire()
        self.assertEqual(result["state"], "VERIFY_REQUIRED")
        self.assertTrue(result["created"])
        old = self.fake.rows[0]
        self.fake.fail_lists = False
        self.fake.rows = []
        self.assertFalse(guard.inspect_adb_forward(self.LEASE)["ready"])
        self.assertTrue(self.lease()["ownership_lost"])
        self.fake.rows = [old]
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(result["state"], "PRESERVED")
        self.assertFalse(result["cleanup_verified"])
        self.assertEqual(self.fake.rows, [old])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_pid_reuse_is_not_the_original_owner(self):
        self.acquire()
        self.identities[self.OWNER] = {"start_ticks": "fixture-birth-2", "boot_id": "fixture-boot"}
        with self.assertRaises(ValueError):
            guard.renew_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(guard.check_and_reconcile(False), 0)
        self.assertEqual(self.fake.rows, [])

    def test_unreadable_live_owner_is_not_assumed_dead(self):
        self.acquire()
        self.unreadable.add(self.OWNER)
        self.assertEqual(guard.check_and_reconcile(False), 2)
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(result["owner_state"], "UNKNOWN")
        self.assertFalse(result["cleanup_verified"])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_unknown_remove_is_not_replayed(self):
        self.acquire()
        self.fake.remove_behavior = "timeout_keep"
        self.assertFalse(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.end_owner()
        self.assertEqual(guard.check_and_reconcile(False), 2)
        self.assertEqual(len(self.fake.mutations()), 2)
        self.assertEqual(len(self.fake.rows), 1)

    def test_remove_lost_reply_with_observed_absence_is_verified(self):
        self.acquire()
        self.fake.remove_behavior = "timeout_removed"
        result = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(result["cleanup_verified"])
        self.assertEqual(result["state"], "CLOSED")

    def test_changed_adb_server_or_unavailable_list_cannot_authorize_removal(self):
        self.acquire()
        self.fake.fail_lists = True
        self.assertFalse(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        self.fake.fail_lists = False
        self.server["ADB_SERVER_SOCKET"] = "tcp:fixture-other-host:5037"
        self.assertFalse(guard.release_adb_forward(self.LEASE, self.OWNER)["cleanup_verified"])
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_forward_does_not_legitimize_an_unmanaged_global_proxy(self):
        self.acquire()
        state = blank(); state["http_proxy"] = {"exists": True, "value": "127.0.0.1:8888"}
        with patch.object(guard, "settings_state", return_value=state), patch.object(guard, "restore_state") as restore:
            self.assertEqual(guard.check_and_reconcile(False), 2)
        restore.assert_not_called()
        self.assertEqual(json.loads(guard.RECEIPT.read_text())["reason"], "unmanaged_global_proxy_detected")
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_unknown_lease_type_never_falls_through_to_proxy_restore(self):
        guard.LEASES.mkdir(parents=True)
        (guard.LEASES / "unknown.json").write_text(json.dumps({"type": "future_unknown", "settings": blank()}))
        with patch.object(guard, "restore_state") as restore:
            self.assertEqual(guard.check_and_reconcile(False), 2)
        restore.assert_not_called()
        self.assertEqual(self.fake.mutations(), [])

    def test_invalid_identity_and_noncanonical_ports_have_no_effect(self):
        for override in ({"lease_id": "../escape"}, {"local": "tcp:00080"}, {"remote": "tcp:0"}, {"owner_pid": True}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.acquire(**override)
        self.assertEqual(self.fake.calls, [])

    def test_cli_requires_stable_owner_and_id_and_returns_verified_result(self):
        args = [str(MODULE), "forward-acquire", "--serial", self.SERIAL, "--local", "tcp:49152",
                "--remote", self.REMOTE, "--owner-pid", str(self.OWNER), "--lease-id", self.LEASE]
        with patch.object(guard.sys, "argv", args), patch.object(guard.sys, "stdout", new_callable=io.StringIO) as output:
            self.assertEqual(guard.main(), 0)
        self.assertTrue(json.loads(output.getvalue())["ready"])
        args = [str(MODULE), "forward-release", self.LEASE, "--owner-pid", str(self.OWNER)]
        with patch.object(guard.sys, "argv", args), patch.object(guard.sys, "stdout", new_callable=io.StringIO) as output:
            self.assertEqual(guard.main(), 0)
        self.assertTrue(json.loads(output.getvalue())["cleanup_verified"])

class LocalFilesystemForwardTests(unittest.TestCase):
    SUFFIX = "b" * 32
    REMOTE = guard.CELLULAR_FORWARD_REMOTE_PREFIX + SUFFIX
    SERIAL = "fixture-device"
    OWNER = 4242
    LEASE = "a" * 32

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "network-mutation"
        self.clock = 10000.0
        self.identities = {self.OWNER: {"start_ticks": "fixture-birth-1", "boot_id": "fixture-boot"}}
        self.server = {"binary": "/fixture/adb", "ADB_SERVER_SOCKET": None}
        self.fake = FakeAdb(self)
        patches = {"ROOT": self.root, "LEASES": self.root / "leases",
                   "RECEIPT": self.root / "health.json", "MAX_LEASE_AGE": 900, "adb": self.fake}
        for name, value in patches.items():
            item = patch.object(guard, name, value); item.start(); self.addCleanup(item.stop)
        for name, function in (("process_identity", lambda pid: self.identities.get(pid)),
                               ("forward_server_identity", lambda: dict(self.server)),
                               ("settings_state", blank)):
            item = patch.object(guard, name, side_effect=function); item.start(); self.addCleanup(item.stop)
        item = patch.object(guard.time, "time", side_effect=lambda: self.clock)
        item.start(); self.addCleanup(item.stop)
        self.prefix = Path(self.tmp.name) / "termux-prefix"
        self.parent = self.prefix / "tmp"
        self.parent.mkdir(parents=True, mode=0o700)
        self.parent.chmod(0o700)
        self.local_path = self.parent / ("samantha-cellular-" + self.SUFFIX + ".sock")
        self.env = patch.dict(os.environ, {"PREFIX": str(self.prefix)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def assert_lock_held(self):
        fd = os.open(self.root / "guard.lock", os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):
                guard.fcntl.flock(fd, guard.fcntl.LOCK_EX | guard.fcntl.LOCK_NB)
        finally:
            os.close(fd)

    def acquire(self, **overrides):
        args = {"serial": self.SERIAL, "local": "localfilesystem:" + str(self.local_path),
                "remote": self.REMOTE, "purpose": "ORANGE CELLULAR FIXTURE ONLY",
                "owner_pid": self.OWNER, "lease_id": self.LEASE}
        args.update(overrides)
        return guard.acquire_adb_forward(**args)

    def test_localfilesystem_endpoint_is_typed_and_cleanup_is_exact(self):
        unrelated = {"serial": "other-device", "local": "tcp:49153", "remote": "tcp:8080"}
        self.fake.rows.append(unrelated)
        acquired = self.acquire()
        self.assertTrue(acquired["ready"])
        self.assertEqual(acquired["endpoint"], {"type": "unix", "socket_path": str(self.local_path)})
        self.assertTrue(self.local_path.exists())
        closed = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(closed["cleanup_verified"] and closed["restored_exact"])
        self.assertFalse(os.path.lexists(self.local_path))
        self.assertEqual(self.fake.rows, [unrelated])

    def test_parent_must_be_real_owned_and_mode_0700(self):
        for mode in (0o750, 0o777):
            with self.subTest(mode=oct(mode)):
                self.parent.chmod(mode)
                with self.assertRaisesRegex(ValueError, "insecure_forward_parent"):
                    self.acquire(lease_id=(f"{mode:032x}"[-32:]))
        self.parent.chmod(0o700)
        with patch.object(guard.os, "geteuid", return_value=os.geteuid() + 1), \
             self.assertRaisesRegex(ValueError, "insecure_forward_parent"):
            self.acquire(lease_id="d" * 32)
        real = self.prefix / "tmp-real"
        self.parent.rename(real)
        self.parent.symlink_to(real, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "insecure_forward_parent"):
            self.acquire(lease_id="c" * 32)
        self.assertEqual(self.fake.mutations(), [])

    def test_only_cellular_remote_and_canonical_socket_name_are_accepted(self):
        bad_name = self.parent / "cellular.sock"
        for overrides in ({"remote": "localabstract:other"},
                          {"local": "localfilesystem:" + str(bad_name)}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.acquire(**overrides)
        self.assertEqual(self.fake.mutations(), [])

    def test_remote_suffix_must_equal_socket_suffix(self):
        with self.assertRaisesRegex(ValueError, "unsupported_forward_remote"):
            self.acquire(remote=guard.CELLULAR_FORWARD_REMOTE_PREFIX + "c" * 32)
        self.assertEqual(self.fake.mutations(), [])

    def test_existing_unowned_path_is_refused_without_mutation(self):
        self.local_path.write_text("foreign")
        result = self.acquire()
        self.assertEqual((result["state"], result["reason"]),
                         ("BLOCKED", "unexpected_forward_socket_path"))
        self.assertEqual(self.fake.mutations(), [])
        self.assertEqual(self.local_path.read_text(), "foreign")
        self.local_path.unlink()
        self.local_path.symlink_to(self.parent / "missing-target")
        result = self.acquire(lease_id="e" * 32)
        self.assertEqual((result["state"], result["reason"]),
                         ("BLOCKED", "unexpected_forward_socket_path"))
        self.assertTrue(self.local_path.is_symlink())
        self.assertEqual(self.fake.mutations(), [])

    def test_socket_inode_change_is_preserved_with_mapping(self):
        self.acquire()
        original = self.local_path.lstat().st_ino
        self.local_path.unlink()
        replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        replacement.bind(str(self.local_path))
        replacement.close()
        self.assertNotEqual(original, self.local_path.lstat().st_ino)
        inspected = guard.inspect_adb_forward(self.LEASE)
        self.assertEqual(inspected["state"], "VERIFY_REQUIRED")
        released = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(released["state"], "PRESERVED")
        self.assertTrue(self.local_path.exists())
        self.assertEqual(len(self.fake.mutations()), 1)

    def test_lost_adb_reply_is_owned_only_for_unique_localfilesystem_effect(self):
        self.fake.create_behavior = "timeout"
        acquired = self.acquire()
        self.assertEqual(acquired["state"], "ACTIVE")
        self.assertTrue(acquired["ready"] and acquired["created"])
        closed = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertTrue(closed["cleanup_verified"])
        self.assertEqual(self.fake.rows, [])
        self.assertFalse(os.path.lexists(self.local_path))

    def test_explicit_create_failure_never_adopts_observed_effect(self):
        self.fake.create_behavior = "nonzero_effect"
        acquired = self.acquire()
        self.assertEqual(acquired["state"], "VERIFY_REQUIRED")
        self.assertFalse(acquired["ready"] or acquired["created"])
        released = guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(released["state"], "VERIFY_REQUIRED")
        self.assertEqual(len(self.fake.mutations()), 1)
        self.assertTrue(self.local_path.exists())

    def test_preexisting_exact_localfilesystem_mapping_is_never_reused(self):
        existing = {"serial": self.SERIAL, "local": "localfilesystem:" + str(self.local_path),
                    "remote": self.REMOTE}
        unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        unix.bind(str(self.local_path)); unix.close()
        self.fake.rows = [existing]
        acquired = self.acquire()
        self.assertEqual((acquired["state"], acquired["reason"]),
                         ("BLOCKED", "preexisting_localfilesystem_forward_preserved"))
        self.assertFalse(acquired["ready"] or acquired["created"] or acquired["reused"])
        guard.release_adb_forward(self.LEASE, self.OWNER)
        self.assertEqual(self.fake.rows, [existing])
        self.assertTrue(self.local_path.exists())
        self.assertEqual(self.fake.mutations(), [])

    def test_crash_after_effect_is_reconciled_from_durable_unique_lease(self):
        self.fake.create_behavior = "crash"
        with self.assertRaises(KeyboardInterrupt):
            self.acquire()
        lease = json.loads((guard.LEASES / (self.LEASE + ".json")).read_text())
        self.assertEqual(lease["state"], "CREATE_REQUESTED")
        self.assertFalse(lease["ownership_proven"])
        self.identities.pop(self.OWNER)
        self.assertEqual(guard.check_and_reconcile(False), 0)
        reconciled = json.loads((guard.LEASES / (self.LEASE + ".json")).read_text())
        self.assertTrue(reconciled["ownership_proven"] and reconciled["cleanup_verified"])
        self.assertEqual(self.fake.rows, [])
        self.assertFalse(os.path.lexists(self.local_path))

if __name__ == "__main__":
    unittest.main(verbosity=2)
