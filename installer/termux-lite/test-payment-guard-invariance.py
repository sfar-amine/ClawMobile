#!/data/data/com.termux/files/usr/bin/python3
"""Garanties paiement du garde réseau partagé (chaîne Orange core #112/#271, décision d'Amine du 17/10 « 4G et Wi-Fi »).

Le garde `android-network-mutation-guard.py` sert à la fois aux consultations Orange (canal attesté) et à la recharge
Maxit déterministe (`with-wifi-off --purpose maxit-topup-payment`). Ces tests prouvent, sans réseau ni ADB réels :
- les fonctions du parcours de recharge sont identiques octet pour octet à la base runtime 636becf5 ;
- les fonctions communes modifiées gardent leur comportement historique hors consultation ;
- une recharge exécute sa commande exactement une fois, sur Wi-Fi comme en 4G, sans forward ni broadcast ajouté ;
- un bail de recharge ne peut jamais servir de canal attesté : sans canal de consultation attesté, refus et aucune exécution.
"""
import ast
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
MODULE = HERE / "android-network-mutation-guard.py"
spec = importlib.util.spec_from_file_location("guard_payment_invariance", MODULE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

helpers_spec = importlib.util.spec_from_file_location("guard_tests_helpers", HERE / "test-android-network-mutation-guard.py")
helpers = importlib.util.module_from_spec(helpers_spec)
helpers_spec.loader.exec_module(helpers)
FakeAndroidSettings = helpers.FakeAndroidSettings

# sha256 des segments source à la base runtime/samantha-companion-private 636becf5 (déployée le 17/10).
PAYMENT_PATH_SHA256 = {
    "with_wifi_off": "6d289316229d1844986070b0444925b510f202feec5cd0ae9de379fad8a26414",
}
PAYMENT_PATH_UNCHANGED = (
    "with_wifi_off", "_run_without_mutation", "run_while_wifi_stays_off", "wifi_toggle_decision",
    "restore_state", "spawn_restorer", "_reconcile_stale_wifi_leases", "read_wifi_lease", "wifi_off_ttl",
    "disable_auto_wifi", "restore_auto_wifi", "restorer_main",
)


def _segments(code: str) -> dict:
    tree = ast.parse(code)
    return {n.name: ast.get_source_segment(code, n) for n in tree.body if isinstance(n, ast.FunctionDef)}


class PaymentGuardInvarianceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (guard.ROOT, guard.LEASES, guard.RECEIPT, guard._CONSULTATION_DEADLINE)
        guard.ROOT = root / "network-mutation"
        guard.LEASES = guard.ROOT / "leases"
        guard.RECEIPT = root / "health" / "receipt.json"
        guard._CONSULTATION_DEADLINE = None
        self.patches = [patch.object(guard, "spawn_restorer", return_value=True), patch.object(guard, "log_line")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        guard.ROOT, guard.LEASES, guard.RECEIPT, guard._CONSULTATION_DEADLINE = self.old
        os.environ.pop("SAMANTHA_MAXIT_LEASE_ID", None)
        os.environ.pop("SAMANTHA_MAXIT_GUARD_LOCK_FD", None)
        self.tmp.cleanup()

    def test_payment_path_functions_are_byte_identical_to_runtime_base(self):
        segments = _segments(MODULE.read_text())
        for name, digest in PAYMENT_PATH_SHA256.items():
            self.assertEqual(hashlib.sha256(segments[name].encode()).hexdigest(), digest, name)
        baseline = HERE.parents[1] / "openclaw-plugin-mobile-ui" / "fixtures" / "payment-guard" / "runtime-636becf5-segments.json"
        pinned = json.loads(baseline.read_text())
        for name in PAYMENT_PATH_UNCHANGED:
            self.assertEqual(hashlib.sha256(segments[name].encode()).hexdigest(), pinned[name], name)

    def test_shared_adb_and_set_wifi_keep_historical_timeouts_outside_consultation(self):
        seen = []
        class P: returncode = 0; stdout = "Wifi is disabled\n"; stderr = ""
        def run(command, **kwargs):
            seen.append(kwargs["timeout"])
            return P()
        with patch.object(guard.subprocess, "run", side_effect=run):
            guard.adb("shell", "true")
            guard.set_wifi(False)
        self.assertEqual(seen[0], 6)
        self.assertTrue(all(t == 6 for t in seen), seen)

    def test_payment_lease_carries_no_consultation_field_and_restores_historically(self):
        fake = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True)
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            lease = guard.create_lease("maxit-topup-payment", lease_type="wifi_off", include_wifi=True, ttl_s=120)
            row = json.loads(lease.read_text())
            self.assertFalse(any(key.startswith("consultation") for key in row), row)
            guard.set_wifi(False)
            with patch.object(guard, "consultation_postcondition", side_effect=AssertionError("consultation path used")):
                guard.restore_lease(row)
        self.assertTrue(fake.wifi)

    def test_mutation_lock_ignores_consultation_pointer_without_delegation(self):
        os.environ["SAMANTHA_MAXIT_LEASE_ID"] = "a" * 32
        with patch.object(guard, "_consultation_inherited_fd", side_effect=AssertionError("delegation used")):
            with guard.mutation_lock() as fd:
                self.assertIsInstance(fd, int)
        self.assertTrue((guard.ROOT / "guard.lock").exists())

    def _topup_on(self, fake):
        executed = []
        def child(command, **_kwargs):
            executed.append(list(command))
            return 0, False
        def plain(command, *a, **k):
            executed.append(list(command))
            class R: returncode = 0
            return R()
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"), \
             patch.object(guard, "run_while_wifi_stays_off", side_effect=child), \
             patch.object(guard.subprocess, "run", side_effect=plain), \
             patch.object(guard, "acquire_adb_forward", side_effect=AssertionError("forward on payment")), \
             patch.object(guard, "with_consultation_receipt", side_effect=AssertionError("channel on payment")):
            code = guard.with_wifi_off("maxit-topup-payment", ["python3", "-m", "telecom.maxit_topup_payment"])
        return code, executed

    def test_topup_executes_exactly_once_on_wifi_and_on_cellular_without_extra_effect(self):
        wifi = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True, connected=True)
        code_wifi, run_wifi = self._topup_on(wifi)
        cellular = FakeAndroidSettings({"auto_wifi": "1", "sem_auto_wifi_control_enabled": "1"}, wifi=True, connected=False)
        code_cell, run_cell = self._topup_on(cellular)
        self.assertEqual((code_wifi, code_cell), (0, 0))
        self.assertEqual(run_wifi, [["python3", "-m", "telecom.maxit_topup_payment"]])
        self.assertEqual(run_cell, run_wifi)  # même commande, une seule exécution, mêmes confirmations en aval
        for fake in (wifi, cellular):
            flat = [" ".join(map(str, c)) for c in fake.calls]
            self.assertFalse([c for c in flat if "forward" in c or " am " in f" {c} " or "broadcast" in c], flat)
        self.assertEqual(wifi.toggles(), [("shell", "svc", "wifi", "disable"), ("shell", "svc", "wifi", "enable")])
        self.assertEqual(cellular.toggles(), [])
        self.assertTrue(wifi.wifi and cellular.wifi)

    def test_payment_lease_never_admits_a_consultation_channel(self):
        fake = FakeAndroidSettings({"auto_wifi": "1"}, wifi=True)
        with patch.object(guard, "adb", side_effect=fake.adb), patch.object(guard.time, "sleep"):
            lease = guard.create_lease("maxit-topup-payment", lease_type="wifi_off", include_wifi=True, ttl_s=120)
        row = json.loads(lease.read_text())
        self.assertFalse(guard.verify_consultation_lease(row["lease_id"]))
        self.assertEqual(guard.consultation_context(row["lease_id"]).get("verified"), False)
        os.environ["SAMANTHA_MAXIT_LEASE_ID"] = row["lease_id"]
        os.environ["SAMANTHA_MAXIT_GUARD_LOCK_FD"] = "3"
        calls_before = len(fake.calls)
        with patch.object(guard, "adb", side_effect=fake.adb):
            with self.assertRaises(RuntimeError) as refused:
                guard.acquire_adb_forward(guard.ADB_ENDPOINT, "tcp:0", "localabstract:ai.samantha.cellular",
                                          owner_pid=os.getpid(), purpose="maxit-topup-payment", lease_id="b" * 32)
        self.assertEqual(str(refused.exception), "maxit_guard_required")
        self.assertEqual(fake.calls[calls_before:], [])  # aucune mutation ni observation ADB


if __name__ == "__main__":
    unittest.main(verbosity=2)
