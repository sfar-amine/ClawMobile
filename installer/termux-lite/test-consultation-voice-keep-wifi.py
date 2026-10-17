#!/usr/bin/env python3
"""Incident Orange vocal du 15/10 : consultation Maxit réussie, réponse parlée absente, chargement infini.

Reçus S24 du 15/10 (21:23-22:11 UTC, lecture seule) : chaque tour vocal « mon solde Orange » a obtenu sa lecture Maxit
en moins d'une seconde, mais le garde a coupé le Wi-Fi (couloir Wi-Fi coupé, bail `wifi_off`) pendant la session vocale
en direct ; la session Gemini Live du Companion sortait par ce Wi-Fi. Le tour vocal est resté sans réponse jusqu'à
l'abandon (transcript `interrupted`, résultat vide), alors que la même demande écrite a réussi.

Correctif : une consultation lancée depuis une session vocale en direct passe `--keep-wifi`. Le garde ne touche jamais
au Wi-Fi : chemin cellulaire attesté (4G principale ou canal cellulaire avec Wi-Fi conservé) ou refus explicite
`orange_cellular_required_wifi_kept`, sans bail, sans enfant, sans appel fournisseur. Hors voix, rien ne change.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("guard_voice_keep_wifi", HERE / "android-network-mutation-guard.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

COMMAND = [sys.executable, "-m", "telecom.maxit_guarded_service", "balance", "--mode", "auto"]
EMPTY = {key: {"exists": False, "value": None} for key in g.KEYS}


def snapshot(route: str) -> dict:
    decision = {"route": route, "reason": {"guarded_fallback": "orange_cellular_not_ready",
                                           "cellular_default": "orange_cellular_default_validated",
                                           "cellular_bound_wifi_unchanged": "orange_cellular_available_wifi_default"}[route],
                "wifi_enabled": True}
    if route == "cellular_bound_wifi_unchanged":
        decision["selection"] = {"networkHandle": 1197406605325, "defaultDataSubscriptionId": 1}
    return {"settings": dict(EMPTY), "auto_wifi": {}, "wifi_enabled": True, "decision": decision, "inspection_ms": 3,
            "postcondition": {"defaultNetwork": {"transport": "wifi", "validated": True}, "defaultNetworkId": 130,
                              "wifiEnabled": True, "wifiConnected": True, "defaultDataSubscriptionId": "1"}}


class VoiceKeepWifiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = (g.ROOT, g.LEASES, g.RECEIPT)
        g.ROOT = root / "network-mutation"
        g.LEASES = g.ROOT / "leases"
        g.RECEIPT = root / "receipt.json"
        g.LEASES.mkdir(parents=True)

    def tearDown(self):
        g.ROOT, g.LEASES, g.RECEIPT = self.old
        self.tmp.cleanup()

    def run_locked(self, route: str, *, keep_wifi: bool, allow_channel: bool = True):
        out = io.StringIO()
        child = []

        def collect(command, env, timeout_s):
            child.append(list(command))
            raise g.ConsultationChildFailure("stop_after_admission", cleanup_verified=True)

        with patch.object(g, "process_identity", return_value={"start_ticks": "1"}), \
             patch.object(g, "canonical_consultation_owner", return_value=True), \
             patch.object(g, "_guard_fd_is_locked", return_value=True), \
             patch.object(g, "capture_consultation_snapshot", return_value=snapshot(route)), \
             patch.object(g, "spawn_restorer", return_value=True), \
             patch.object(g, "set_wifi", side_effect=AssertionError("Wi-Fi toggled")) as toggle, \
             patch.object(g, "collect_consultation_child", side_effect=collect), \
             patch.object(g, "cleanup_consultation_channel", return_value=(True, {})), \
             patch.object(g, "restore_lease"), patch.object(g, "write_receipt"), redirect_stdout(out):
            code = g._with_consultation_receipt_locked(COMMAND, lock_fd=3, allow_cellular_channel=allow_channel,
                                                       keep_wifi=keep_wifi)
        return code, json.loads(out.getvalue().strip().splitlines()[-1]), child, toggle

    def test_incident_1015_live_voice_never_cuts_wifi_and_says_why(self):
        code, payload, child, toggle = self.run_locked("guarded_fallback", keep_wifi=True)
        self.assertEqual(code, 4)
        self.assertEqual(payload["state"], "orange_cellular_required_wifi_kept")
        self.assertEqual(payload["reason"], "orange_cellular_not_ready")
        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["network_guard"]["path"], "blocked")
        self.assertIs(payload["network_guard"]["wifi_disabled"], False)
        toggle.assert_not_called()
        self.assertEqual(child, [])                      # aucun appel fournisseur
        self.assertEqual(list(g.LEASES.iterdir()), [])   # aucun bail, rien à restaurer

    def test_live_voice_ui_mode_without_channel_is_refused_not_toggled(self):
        code, payload, child, toggle = self.run_locked("cellular_bound_wifi_unchanged", keep_wifi=True, allow_channel=False)
        self.assertEqual((code, payload["state"]), (4, "orange_cellular_required_wifi_kept"))
        toggle.assert_not_called()
        self.assertEqual(child, [])

    def test_live_voice_keeps_attested_cellular_paths(self):
        for route in ("cellular_bound_wifi_unchanged", "cellular_default"):
            code, payload, child, toggle = self.run_locked(route, keep_wifi=True)
            self.assertEqual(child, [COMMAND], route)
            toggle.assert_not_called()
            self.assertEqual(payload["network_guard"]["path"], route)
            self.assertIs(payload["network_guard"]["wifi_disabled"], False)

    def test_text_surfaces_keep_the_existing_wifi_off_corridor(self):
        out = io.StringIO()
        toggles = []
        with patch.object(g, "process_identity", return_value={"start_ticks": "1"}), \
             patch.object(g, "canonical_consultation_owner", return_value=True), \
             patch.object(g, "_guard_fd_is_locked", return_value=True), \
             patch.object(g, "capture_consultation_snapshot", return_value=snapshot("guarded_fallback")), \
             patch.object(g, "spawn_restorer", return_value=True), \
             patch.object(g, "set_wifi", side_effect=lambda enabled, *a, **k: toggles.append(enabled)), \
             patch.object(g, "collect_consultation_child",
                          side_effect=g.ConsultationChildFailure("stop_after_admission", cleanup_verified=True)), \
             patch.object(g, "cleanup_consultation_channel", return_value=(True, {})), \
             patch.object(g, "restore_lease"), patch.object(g, "write_receipt"), redirect_stdout(out):
            g._with_consultation_receipt_locked(COMMAND, lock_fd=3, keep_wifi=False)
        self.assertEqual(toggles, [False])
        self.assertIs(json.loads(out.getvalue().strip().splitlines()[-1])["network_guard"]["wifi_disabled"], True)

    def test_cli_exposes_keep_wifi_only_on_consultation(self):
        seen = {}
        def consult(command, *, allow_cellular_channel=True, keep_wifi=False):
            seen.update(command=command, allow=allow_cellular_channel, keep=keep_wifi)
            return 0
        with patch.object(g, "with_consultation_receipt", side_effect=consult), \
             patch.object(sys, "argv", ["guard", "with-consultation-receipt", "--keep-wifi", "--", *COMMAND]):
            self.assertEqual(g.main(), 0)
        self.assertEqual(seen, {"command": COMMAND, "allow": True, "keep": True})
        with patch.object(sys, "argv", ["guard", "with-wifi-off", "--keep-wifi", "--", "true"]), \
             redirect_stdout(io.StringIO()), patch("sys.stderr", new_callable=io.StringIO):
            with self.assertRaises(SystemExit):
                g.main()  # le parcours paiement n'accepte pas ce drapeau : aucun changement de son contrat


if __name__ == "__main__":
    unittest.main(verbosity=2)
