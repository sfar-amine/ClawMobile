#!/data/data/com.termux/files/usr/bin/python3
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name("adb-recovery-readiness.py")
spec = importlib.util.spec_from_file_location("arr", MODULE)
arr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(arr)

class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (arr.STATE_DIR, arr.HEALTH_DIR, arr.RECEIPT, arr.EXPECTED, arr.LAST_ENDPOINT)
        arr.STATE_DIR = root / "watchdogs"
        arr.HEALTH_DIR = root / "health"
        arr.RECEIPT = arr.HEALTH_DIR / "adb-recovery-readiness.json"
        arr.EXPECTED = arr.STATE_DIR / "adb-expected-serial"
        arr.LAST_ENDPOINT = arr.STATE_DIR / "adb-last-endpoint"
        arr.STATE_DIR.mkdir()
        arr.EXPECTED.write_text("SERIAL1")

    def tearDown(self):
        arr.STATE_DIR, arr.HEALTH_DIR, arr.RECEIPT, arr.EXPECTED, arr.LAST_ENDPOINT = self.old
        self.tmp.cleanup()

    def test_canonical_down_is_unverified_not_false_degraded(self):
        with patch.object(arr, "canonical_status", return_value=("", "", False)):
            row = arr.probe(persist=False)
        self.assertEqual(row["state"], "unverified")
        self.assertEqual(row["reason"], "canonical_adb_unavailable")

    def test_wireless_disabled_is_standby_without_discovery(self):
        with patch.object(arr, "canonical_status", return_value=("device", "SERIAL1", True)), \
             patch.object(arr, "wifi_enabled", return_value=True), \
             patch.object(arr, "wireless_setting", return_value="0"), \
             patch.object(arr, "discover_endpoints") as discover:
            row = arr.probe(persist=False)
        self.assertEqual(row["state"], "standby")
        self.assertEqual(row["reason"], "wireless_debugging_disabled_primary_healthy")
        self.assertFalse(row["requires_owner_action"])
        discover.assert_not_called()

    def test_wifi_off_is_standby_while_primary_is_healthy(self):
        with patch.object(arr, "canonical_status", return_value=("device", "SERIAL1", True)), \
             patch.object(arr, "wifi_enabled", return_value=False), \
             patch.object(arr, "wireless_setting", return_value="0"), \
             patch.object(arr, "discover_endpoints") as discover:
            row = arr.probe(persist=False)
        self.assertEqual(row["state"], "standby")
        self.assertEqual(row["reason"], "wifi_disabled_recovery_standby")
        self.assertFalse(row["requires_owner_action"])
        discover.assert_not_called()

    def test_verified_dynamic_endpoint_is_ready_and_persisted(self):
        with patch.object(arr, "canonical_status", return_value=("device", "SERIAL1", True)), \
             patch.object(arr, "wireless_setting", return_value="1"), \
             patch.object(arr, "discover_endpoints", return_value=["10.0.0.2:37123"]), \
             patch.object(arr, "verify_endpoint", return_value=True):
            row = arr.probe(persist=True)
        self.assertEqual(row["state"], "ready")
        self.assertTrue(row["endpoint_verified"])
        self.assertEqual(arr.LAST_ENDPOINT.read_text(), "10.0.0.2:37123")
        self.assertTrue(arr.RECEIPT.exists())

    def test_enabled_but_missing_endpoint_is_standby_while_primary_is_healthy(self):
        with patch.object(arr, "canonical_status", return_value=("device", "SERIAL1", True)), \
             patch.object(arr, "wifi_enabled", return_value=True), \
             patch.object(arr, "wireless_setting", return_value="1"), \
             patch.object(arr, "discover_endpoints", return_value=[]):
            row = arr.probe(persist=False)
        self.assertEqual(row["state"], "standby")
        self.assertEqual(row["reason"], "wireless_endpoint_not_discoverable_primary_healthy")
        self.assertFalse(row["requires_owner_action"])

    def test_unknown_setting_without_endpoint_is_unverified(self):
        with patch.object(arr, "canonical_status", return_value=("device", "SERIAL1", True)), \
             patch.object(arr, "wifi_enabled", return_value=True), \
             patch.object(arr, "wireless_setting", return_value=None), \
             patch.object(arr, "discover_endpoints", return_value=[]):
            row = arr.probe(persist=False)
        self.assertEqual(row["state"], "unverified")
        self.assertEqual(row["reason"], "wireless_state_unobservable")

if __name__ == "__main__":
    unittest.main()
