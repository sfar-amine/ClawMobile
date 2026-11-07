#!/usr/bin/env python3
"""Décision d'Amine du 07/11/2026 « App Max it d'abord » : le garde lit l'app Max it sur Wi-Fi, sans mutation réseau.

Faits S24 (openclaw-plugin-mobile-ui/fixtures/s24-2026-11-07-orange-app-session) : à 20:18 le garde coupait le Wi-Fi
(`guarded_fallback`, `orange_cellular_not_ready`) ; l'API Orange en 4G répondait `waaat_auth_failed` ; Max it, une fois
connecté par la 4G, montre le solde sur Wi-Fi. En mode app (`--mode app`) :
- phase A `app_session_wifi` : même bail, aucune mutation, l'enfant lit l'app ;
- phase B : seulement si l'enfant répond `mobile_network_required` (`maxit_signed_out` ou `screen_locked`), hors voix et
  avec au moins 20 s de budget, le couloir `guarded_fallback` existant dans le même bail et la même échéance ;
- voix en direct (`--keep-wifi`) : phase A, puis refus `orange_cellular_required_wifi_kept` sans mutation.
Les autres modes ne changent pas. Aucun ADB, réseau ni fournisseur réel : fonctions du téléphone injectées.
"""
import importlib.util
import io
import json
import re
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("guard_app_session_first", HERE / "android-network-mutation-guard.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
fast_spec = importlib.util.spec_from_file_location("guard_fastpath_shapes", HERE / "test-consultation-fastpath.py")
fast = importlib.util.module_from_spec(fast_spec)
fast_spec.loader.exec_module(fast)

FIXTURE_DIR = HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-11-07-orange-app-session"
FACTS = json.loads((FIXTURE_DIR / "app-session-evidence.json").read_text(encoding="utf-8"))
REAL_PROOF = FACTS["guardReceipt2018"]["network_guard"]
REAL_REASON = FACTS["guardReceipt2018"]["reason"]
DATA_SUB = FACTS["defaultDataSubscription"]["subscriptionId"]

APP = [sys.executable, "-m", "telecom.maxit_guarded_service", "balance", "--mode", "app", "mon solde orange"]
AUTO = [sys.executable, "-m", "telecom.maxit_guarded_service", "balance", "--mode", "auto", "mon solde orange"]
PROOF_KEYS = {"wifi_initial", "wifi_disabled", "dns_ready_ms", "restored", "lease_id", "path"}
EMPTY = {key: {"exists": False, "value": None} for key in g.KEYS}
REASONS = {"guarded_fallback": REAL_REASON, "cellular_default": "orange_cellular_default_validated",
           "cellular_bound_wifi_unchanged": "orange_cellular_available_wifi_default", "blocked": "vpn_active"}


def snapshot(route: str) -> dict:
    decision = {"route": route, "reason": REASONS[route], "wifi_enabled": REAL_PROOF["wifi_initial"]}
    if route == "cellular_bound_wifi_unchanged":
        decision["selection"] = {"networkHandle": 1197406605325, "defaultDataSubscriptionId": DATA_SUB}
    return {"settings": dict(EMPTY), "auto_wifi": {}, "wifi_enabled": REAL_PROOF["wifi_initial"], "decision": decision,
            "inspection_ms": 3,
            "postcondition": {"defaultNetwork": {"transport": "wifi", "validated": True}, "defaultNetworkId": 130,
                              "wifiEnabled": True, "wifiConnected": True, "defaultDataSubscriptionId": str(DATA_SUB)}}


def child(value: dict, code: int | None = None) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], (0 if value.get("ok") is True else 4) if code is None else code,
                                       json.dumps(value), "")


SERVED = {"ok": True, "source": "maxit_app", "cards": ["solde lu dans l'app"]}
SIGNED_OUT = {"ok": False, "source": "maxit_app", "state": "mobile_network_required", "reason": "maxit_signed_out"}
LOCKED = {"ok": False, "source": "maxit_app", "state": "mobile_network_required", "reason": "screen_locked"}
CORRIDOR_OK = {"ok": True, "source": "maxit_app", "cards": ["solde lu en 4G"], "dns_ready_ms": REAL_PROOF["dns_ready_ms"]}


class AppSessionFirstTests(unittest.TestCase):
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

    def run_guard(self, route, command, outputs, *, keep_wifi=False, allow_channel=True, deadline=None):
        """Real lease file, real consultation_context/restore_lease/channel cleanup; injected phone and child."""
        wifi = {"on": REAL_PROOF["wifi_initial"]}
        trace = {"toggles": [], "children": [], "lease_at_disable": [], "receipts": [], "postconditions": []}
        outputs = list(outputs)
        before = {p.name for p in g.LEASES.glob("*.json")}

        def own_lease() -> Path:
            (lease,) = [p for p in g.LEASES.glob("*.json") if p.name not in before]
            return lease

        def set_wifi(enabled, *_a, **_k):
            if enabled is False:
                trace["lease_at_disable"].append(json.loads(own_lease().read_text()))
            trace["toggles"].append(enabled)
            wifi["on"] = enabled

        def inherited(lease_id):
            return json.loads((g.LEASES / (lease_id + ".json")).read_text()), 3

        def collect(command_, env, timeout_s):
            lease_id = env["SAMANTHA_MAXIT_LEASE_ID"]
            # As the real collector: the child identity is journalled in the lease before the module runs.
            path = g.LEASES / (lease_id + ".json")
            row = json.loads(path.read_text())
            row["consultation_child"] = {"pid": 4242 + len(trace["children"]), "pgid": 4242 + len(trace["children"]),
                                         "identity": {"start_ticks": "2", "boot_id": "TEST"}}
            g.write_json(path, row)
            trace["children"].append({"command": list(command_), "lease_id": lease_id, "timeout_s": timeout_s,
                                      "wifi_on": wifi["on"], "context": g.consultation_context(lease_id)})
            result = outputs.pop(0)
            if isinstance(result, BaseException):
                raise result
            return result

        def postcondition(row, *, wait=False):
            trace["postconditions"].append((row.get("consultation_wifi_toggled"), wait, wifi["on"]))
            return wifi["on"] is True

        out = io.StringIO()
        with patch.object(g, "process_identity", return_value={"start_ticks": "1", "boot_id": "TEST"}), \
             patch.object(g, "canonical_consultation_owner", return_value=True), \
             patch.object(g, "_guard_fd_is_locked", return_value=True), \
             patch.object(g, "capture_consultation_snapshot", return_value=snapshot(route)), \
             patch.object(g, "spawn_restorer", return_value=True), \
             patch.object(g, "set_wifi", side_effect=set_wifi), \
             patch.object(g, "wifi_enabled", side_effect=lambda: wifi["on"]), \
             patch.object(g, "restore_state"), patch.object(g, "restore_auto_wifi"), \
             patch.object(g, "consultation_postcondition", side_effect=postcondition), \
             patch.object(g, "_consultation_inherited_fd", side_effect=inherited), \
             patch.object(g, "collect_consultation_child", side_effect=collect), \
             patch.object(g, "write_receipt", side_effect=lambda *a, **k: trace["receipts"].append((a, k))), \
             redirect_stdout(out):
            code = g._with_consultation_receipt_locked(command, deadline, lock_fd=3,
                                                       allow_cellular_channel=allow_channel, keep_wifi=keep_wifi)
        trace["wifi_final"] = wifi["on"]
        trace["leases_left"] = sorted(p.name for p in g.LEASES.glob("*.json") if p.name not in before)
        return code, json.loads(out.getvalue().strip().splitlines()[-1]), trace

    # --- Phase A ---------------------------------------------------------------------------------------------------
    def test_phase_a_reads_the_app_on_wifi_without_any_network_mutation(self):
        code, payload, trace = self.run_guard("guarded_fallback", APP, [child(SERVED)])
        self.assertEqual(code, 0)
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["cards"], SERVED["cards"])
        self.assertEqual(trace["toggles"], [])                       # aucun set_wifi, ni coupure ni restauration
        self.assertEqual(len(trace["children"]), 1)
        context = trace["children"][0]["context"]
        self.assertEqual((context["verified"], context["route"], context["wifiToggled"], context["reason"]),
                         (True, "app_session_wifi", False, "maxit_app_session_first"))
        self.assertNotIn("selection", context)
        self.assertTrue(trace["children"][0]["wifi_on"])
        guard = payload["network_guard"]
        self.assertEqual(set(guard), PROOF_KEYS)
        self.assertEqual((guard["path"], guard["wifi_initial"], guard["wifi_disabled"], guard["restored"], guard["dns_ready_ms"]),
                         ("app_session_wifi", True, False, True, None))
        self.assertEqual(payload["network_path"], "app_session_wifi")
        self.assertEqual(payload["network_metrics"], {"network_inspection_ms": 3, "wifi_toggled": False, "app_session": "served"})
        # Restauration existante sans mutation : la postcondition réseau inchangée est prouvée, puis le bail est retiré.
        self.assertEqual(trace["postconditions"], [(False, False, True)])
        self.assertEqual(trace["leases_left"], [])
        self.assertEqual(trace["receipts"][-1][0][:2], ("healthy", "consultation_network_restored"))

    def test_phase_a_other_results_are_final_without_mutation(self):
        for value in ({"ok": False, "source": "maxit_app", "state": "provider_unavailable"},
                      {"ok": False, "source": "maxit_app", "state": "mobile_network_required", "reason": "other"},
                      {"ok": False, "source": "maxit_app", "state": "mobile_network_required", "reason": ["maxit_signed_out"]},
                      {"ok": False, "source": "maxit_app", "state": "app_unavailable", "reason": "maxit_signed_out"}):
            with self.subTest(value=value):
                code, payload, trace = self.run_guard("guarded_fallback", APP, [child(value)])
                self.assertEqual(code, 4)
                self.assertEqual(payload["state"], value["state"])
                self.assertEqual(trace["toggles"], [])
                self.assertEqual(len(trace["children"]), 1)
                self.assertEqual(payload["network_guard"]["path"], "app_session_wifi")
                self.assertEqual(payload["network_metrics"]["app_session"], "served")

    def test_phase_a_child_failure_never_escalates(self):
        for failure, state, restored in ((g.ConsultationChildFailure("child_cleanup_unverified", False), "child_cleanup_unverified", False),
                                         (g.ConsultationChildFailure("consultation_total_bound_exceeded", True), "consultation_total_bound_exceeded", True)):
            with self.subTest(state=state):
                code, payload, trace = self.run_guard("guarded_fallback", APP, [failure, child(CORRIDOR_OK)])
                self.assertEqual((code, payload["state"]), (4, state))
                self.assertEqual(trace["toggles"], [])
                self.assertEqual(len(trace["children"]), 1)
                self.assertIs(payload["network_guard"]["restored"], restored)
                self.assertEqual(bool(trace["leases_left"]), not restored)  # unverified cleanup keeps the lease
                self.assertEqual(payload["network_metrics"]["app_session"], "served")

    # --- Phase B ---------------------------------------------------------------------------------------------------
    def test_signed_out_or_locked_screen_escalates_to_the_existing_corridor_in_the_same_lease(self):
        for first, label in ((SIGNED_OUT, "escalated_maxit_signed_out"), (LOCKED, "escalated_screen_locked")):
            with self.subTest(reason=first["reason"]):
                code, payload, trace = self.run_guard("guarded_fallback", APP, [child(first), child(CORRIDOR_OK)])
                self.assertEqual(code, 0)
                self.assertIs(payload["ok"], True)
                self.assertEqual(payload["cards"], CORRIDOR_OK["cards"])
                self.assertEqual(trace["toggles"], [False, True])     # une seule coupure, puis la restauration
                a, b = trace["children"]
                self.assertEqual(a["command"], APP)
                self.assertEqual(b["command"], APP)                   # même commande enfant, rejouée une fois
                self.assertEqual(a["lease_id"], b["lease_id"])        # même bail
                self.assertTrue(a["wifi_on"])
                self.assertFalse(b["wifi_on"])
                self.assertEqual((a["context"]["route"], a["context"]["wifiToggled"]), ("app_session_wifi", False))
                self.assertEqual((b["context"]["route"], b["context"]["wifiToggled"], b["context"]["reason"]),
                                 ("guarded_fallback", True, REAL_REASON))
                self.assertLessEqual(b["timeout_s"], a["timeout_s"])  # même échéance
                self.assertLessEqual(b["context"]["remainingBudgetMs"], a["context"]["remainingBudgetMs"])
                # Journalisé avant la coupure : le restaurateur détaché rallumerait le Wi-Fi si le garde mourait.
                journal = trace["lease_at_disable"][0]
                self.assertEqual(journal["consultation_decision"]["route"], "guarded_fallback")
                self.assertIs(journal["consultation_wifi_toggled"], True)
                self.assertEqual(journal["consultation_child"]["pid"], 4242)  # phase A journal kept, child collected
                expected = {**REAL_PROOF, "lease_id": a["lease_id"]}  # preuve réelle S24 de 20:18
                self.assertEqual(payload["network_guard"], expected)
                self.assertEqual(payload["network_path"], "guarded_fallback")
                self.assertEqual(payload["network_metrics"], {"network_inspection_ms": 3, "wifi_toggled": True, "app_session": label})
                self.assertTrue(trace["wifi_final"])
                self.assertEqual(trace["leases_left"], [])
                self.assertEqual(trace["postconditions"][-1], (True, True, True))

    def test_phase_b_reuses_the_converted_corridor_decision_when_the_channel_is_disabled(self):
        code, payload, trace = self.run_guard("cellular_bound_wifi_unchanged", APP, [child(SIGNED_OUT), child(CORRIDOR_OK)],
                                              allow_channel=False)
        self.assertEqual(code, 0)
        self.assertEqual(trace["children"][0]["context"]["route"], "app_session_wifi")
        self.assertEqual((trace["children"][1]["context"]["route"], trace["children"][1]["context"]["reason"]),
                         ("guarded_fallback", "channel_disabled_for_canonical_consultation"))
        self.assertEqual(trace["toggles"], [False, True])
        self.assertEqual(payload["network_guard"]["path"], "guarded_fallback")

    def test_phase_b_failure_is_reported_and_wifi_is_still_restored(self):
        code, payload, trace = self.run_guard("guarded_fallback", APP,
                                              [child(SIGNED_OUT), g.ConsultationChildFailure("consultation_total_bound_exceeded", True)])
        self.assertEqual((code, payload["state"]), (4, "consultation_total_bound_exceeded"))
        self.assertEqual(trace["toggles"], [False, True])
        self.assertEqual(payload["network_guard"]["path"], "guarded_fallback")
        self.assertIs(payload["network_guard"]["restored"], True)
        self.assertEqual(payload["network_metrics"]["app_session"], "escalated_maxit_signed_out")
        _, contradictory, _ = self.run_guard("guarded_fallback", APP, [child(SIGNED_OUT), child({"ok": True}, code=4)])
        self.assertEqual(contradictory["state"], "child_result_contradictory")

    def test_budget_too_small_for_a_real_read_refuses_without_mutation(self):
        deadline = time.monotonic() + g.CONSULTATION_RESTORE_RESERVE_S + g.APP_SESSION_ESCALATION_MIN_S - 2.0
        code, payload, trace = self.run_guard("guarded_fallback", APP, [child(SIGNED_OUT), child(CORRIDOR_OK)], deadline=deadline)
        self.assertEqual(code, 4)
        self.assertEqual({k: payload[k] for k in ("ok", "source", "state")},
                         {"ok": False, "source": "maxit_network_guard", "state": "consultation_budget_exhausted"})
        self.assertEqual(trace["toggles"], [])
        self.assertEqual(len(trace["children"]), 1)
        self.assertEqual(payload["network_guard"]["path"], "app_session_wifi")
        self.assertIs(payload["network_guard"]["restored"], True)
        self.assertEqual(payload["network_metrics"]["app_session"], "budget_exhausted")
        # Just enough budget: the corridor runs.
        deadline = time.monotonic() + g.CONSULTATION_RESTORE_RESERVE_S + g.APP_SESSION_ESCALATION_MIN_S + 5.0
        code, payload, trace = self.run_guard("guarded_fallback", APP, [child(SIGNED_OUT), child(CORRIDOR_OK)], deadline=deadline)
        self.assertEqual((code, trace["toggles"], payload["network_metrics"]["app_session"]),
                         (0, [False, True], "escalated_maxit_signed_out"))

    # --- Voix en direct ----------------------------------------------------------------------------------------------
    def test_live_voice_runs_phase_a_and_refuses_the_corridor_without_mutation(self):
        code, payload, trace = self.run_guard("guarded_fallback", APP, [child(SERVED)], keep_wifi=True)
        self.assertEqual((code, payload["ok"], trace["toggles"]), (0, True, []))
        self.assertEqual(payload["network_metrics"]["app_session"], "served")
        for first in (SIGNED_OUT, LOCKED):
            with self.subTest(reason=first["reason"]):
                code, payload, trace = self.run_guard("guarded_fallback", APP, [child(first), child(CORRIDOR_OK)], keep_wifi=True)
                self.assertEqual(code, 4)
                self.assertEqual({k: payload[k] for k in ("ok", "source", "state", "reason")},
                                 {"ok": False, "source": "maxit_network_guard", "state": "orange_cellular_required_wifi_kept",
                                  "reason": first["reason"]})
                self.assertEqual(trace["toggles"], [])
                self.assertEqual(len(trace["children"]), 1)
                self.assertEqual(trace["children"][0]["context"]["route"], "app_session_wifi")
                guard = payload["network_guard"]
                self.assertEqual(set(guard), PROOF_KEYS)
                self.assertEqual((guard["path"], guard["wifi_disabled"], guard["restored"]), ("app_session_wifi", False, True))
                self.assertEqual(payload["network_metrics"]["app_session"], "declined_wifi_kept")

    # --- Autres routes et autres modes inchangés ------------------------------------------------------------------
    def test_cellular_default_in_app_mode_runs_once_without_phase_a(self):
        code, payload, trace = self.run_guard("cellular_default", APP, [child(SIGNED_OUT), child(CORRIDOR_OK)])
        self.assertEqual((code, payload["state"]), (4, "mobile_network_required"))
        self.assertEqual(len(trace["children"]), 1)
        self.assertEqual(trace["children"][0]["context"]["route"], "cellular_default")
        self.assertEqual(trace["toggles"], [])
        self.assertEqual(payload["network_guard"]["path"], "cellular_default")
        self.assertEqual(payload["network_metrics"]["app_session"], "not_applicable")

    def test_blocked_decision_is_unchanged_in_app_mode(self):
        code, payload, trace = self.run_guard("blocked", APP, [child(SERVED)])
        self.assertEqual((code, payload["state"], payload["network_guard"]["path"]), (4, "vpn_active", "blocked"))
        self.assertEqual((trace["children"], trace["toggles"], trace["leases_left"]), ([], [], []))
        self.assertNotIn("network_metrics", payload)

    def test_other_modes_keep_the_immediate_corridor_and_the_voice_refusal(self):
        for mode in ("auto", "silent", "ui"):
            command = [*AUTO[:4], "--mode", mode]
            with self.subTest(mode=mode):
                code, payload, trace = self.run_guard("guarded_fallback", command, [child(SIGNED_OUT), child(CORRIDOR_OK)])
                self.assertEqual(trace["toggles"], [False, True])      # corridor before the only child run
                self.assertEqual(len(trace["children"]), 1)
                self.assertFalse(trace["children"][0]["wifi_on"])
                self.assertEqual(trace["children"][0]["context"]["route"], "guarded_fallback")
                self.assertEqual((code, payload["state"]), (4, "mobile_network_required"))
                self.assertEqual(payload["network_guard"]["path"], "guarded_fallback")
                self.assertEqual(payload["network_metrics"]["app_session"], "not_applicable")
                code, payload, trace = self.run_guard("guarded_fallback", command, [child(SERVED)], keep_wifi=True)
                self.assertEqual((code, payload["state"], payload["network_guard"]["path"]),
                                 (4, "orange_cellular_required_wifi_kept", "blocked"))
                self.assertEqual(payload["reason"], REAL_REASON)
                self.assertEqual((trace["children"], trace["toggles"], trace["leases_left"]), ([], [], []))
        code, payload, trace = self.run_guard("cellular_bound_wifi_unchanged", AUTO, [child(SERVED)], allow_channel=False)
        self.assertEqual((trace["toggles"], payload["network_guard"]["path"]), ([False, True], "guarded_fallback"))

    def test_trigger_is_the_consecutive_mode_app_pair_only(self):
        self.assertTrue(g.app_session_first(APP))
        self.assertTrue(g.app_session_first([*AUTO[:4], "--mode", "app"]))
        for command in (AUTO, [*AUTO[:4], "--mode=app"], [*AUTO[:4], "app", "--mode"], [*AUTO[:4], "--mode", "auto", "app"]):
            self.assertFalse(g.app_session_first(command), command)
        code, payload, trace = self.run_guard("guarded_fallback", [*AUTO[:4], "--mode=app"], [child(SERVED)])
        self.assertEqual(trace["toggles"], [False, True])
        self.assertEqual(payload["network_guard"]["path"], "guarded_fallback")

    # --- consultation_context -----------------------------------------------------------------------------------
    def test_consultation_context_admits_app_session_wifi(self):
        lease_id = "c" * 32
        row = {"consultation_decision": {"route": "app_session_wifi", "reason": "maxit_app_session_first", "wifi_enabled": True},
               "consultation_deadline": time.monotonic() + g.CONSULTATION_TOTAL_S, "consultation_wifi_toggled": False}
        with patch.object(g, "_consultation_inherited_fd", return_value=(row, 3)):
            context = g.consultation_context(lease_id)
            self.assertEqual(context, {"schemaVersion": 1, "verified": True, "state": "admitted", "route": "app_session_wifi",
                                       "remainingBudgetMs": context["remainingBudgetMs"], "wifiToggled": False,
                                       "reason": "maxit_app_session_first"})
            self.assertTrue(0 < context["remainingBudgetMs"] <= 44000)
            row["consultation_decision"] = {"route": "app_session_evil", "reason": "x"}
            self.assertEqual(g.consultation_context(lease_id)["reason"], "network_selection_unavailable")
        # A cellular channel is never admitted under the app route.
        row["consultation_decision"] = {"route": "app_session_wifi", "reason": "maxit_app_session_first", "wifi_enabled": True}
        with patch.object(g, "consultation_context", return_value={"verified": True, "route": "app_session_wifi"}), \
             patch.dict(g.os.environ, {"SAMANTHA_MAXIT_LEASE_ID": lease_id}):
            self.assertIs(g.verify_consultation_channel("d" * 32, "e" * 32)["verified"], False)

    # --- Fixture réelle ------------------------------------------------------------------------------------------
    def test_real_s24_state_of_2018_is_the_phase_a_starting_decision(self):
        wifi_only = [n for n in fast.shape["network"]["networks"] if n["wifi"]]   # Orange 4G absent en parallèle
        raw = fast.projected_network(wifi_only, wifi_only[0]["net_id"])
        decision = g.parse_consultation_selection(raw, str(DATA_SUB), fast.SUBSCRIPTIONS, REAL_PROOF["wifi_initial"])
        self.assertEqual((decision["route"], decision["reason"]), ("guarded_fallback", REAL_REASON))
        self.assertEqual(FACTS["defaultDataSubscription"], {"subscriptionId": 1, "carrier": "Orange", "radio": "LTE"})
        self.assertEqual([a["state"] for a in FACTS["orangeApiOver4g"]["answers"]], ["waaat_auth_failed"] * 2)
        self.assertEqual(FACTS["ownerDecision"]["cellularOnlyWhen"], sorted(g.APP_SESSION_ESCALATION_REASONS))
        text = (FIXTURE_DIR / "app-session-evidence.json").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"\+?\d{8,}", text))                    # aucun numéro de ligne
        self.assertIsNone(re.search(r"(?i)(password|bearer|cookie|api[_ -]?key|\btoken\b|\bdt\b|\btnd\b)", text))


if __name__ == "__main__":
    unittest.main(verbosity=2)
