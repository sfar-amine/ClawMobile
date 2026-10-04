#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name("android-network-mutation-guard.py")
spec = importlib.util.spec_from_file_location("guard", MODULE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

def blank():
    return {k: {"exists": False, "value": None} for k in guard.KEYS}

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "receipt.json"

    def tearDown(self):
        guard.ROOT, guard.LEASES, guard.RECEIPT = self.old
        self.tmp.cleanup()

    def test_restore_absent_keys_uses_delete_not_literal_null(self):
        expected = blank()
        calls = []
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard, "adb", side_effect=fake_adb), patch.object(guard, "settings_state", return_value=expected):
            guard.restore_state(expected)
        deletes = [c for c in calls if c[:4] == ("shell","settings","delete","global")]
        puts = [c for c in calls if c[:4] == ("shell","settings","put","global")]
        self.assertEqual(len(deletes), len(guard.KEYS))
        self.assertEqual(puts, [])

    def test_restore_existing_sentinel_is_exact(self):
        expected = blank()
        expected["http_proxy"] = {"exists": True, "value": ":0"}
        calls = []
        def fake_adb(*args, **kwargs):
            calls.append(args)
            class P: returncode=0; stdout=""
            return P()
        with patch.object(guard, "adb", side_effect=fake_adb), patch.object(guard, "settings_state", return_value=expected):
            guard.restore_state(expected)
        self.assertIn(("shell","settings","put","global","http_proxy",":0"), calls)

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

if __name__ == "__main__":
    unittest.main(verbosity=2)
