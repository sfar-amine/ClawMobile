"""R4 presentation contract. Canonical graph fixtures; no S24 dispatch."""
import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2] / "installer/termux-lite/model-fast-path.py"
spec = importlib.util.spec_from_file_location("model_fast_path_r4", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ComposedReadResultTests(unittest.TestCase):
    def execute(self, state, rows):
        selected = {"state": "ready", "authorized": True, "deterministic": True,
                    "model_required": False, "risk": "read", "capability": "skill.intelligence",
                    "execution_contract": {"strategy": "composed_read"}}
        resolution = {"selected": selected, "harness": {"tool_policy": "required"},
                      "decision": {"type": "EXECUTE", "reason": "capability_first"}}
        payload = {"strategy": "composed_read", "ok": state == "completed", "state": state, "results": rows}
        executed = {**resolution, "execution": {"state": state, "result": payload}}
        with patch.object(module, "resolve_capability", return_value=resolution) as resolve, \
                patch.object(module, "execute_capability_decision", return_value=executed) as dispatch:
            out = module.try_fast_path("mes soldes orange et tt")
        self.assertEqual(resolve.call_count, 1)
        self.assertEqual(dispatch.call_count, 1)
        self.assertTrue(out["model_bypassed"])
        self.assertEqual(out["result"], payload)
        return out

    def rows(self):
        return [{"target": "maxit-tunisie", "label": "Orange", "state": "completed",
                 "result": {"ok": True, "text": "Compte recharge : 1.234 DT"}},
                {"target": "tunisie-telecom", "label": "Tunisie Télécom", "state": "completed",
                 "result": {"ok": True, "text": "Principal : 5.678 DT"}}]

    def test_complete_result_displays_both_without_inventing_total(self):
        out = self.execute("completed", self.rows())
        self.assertEqual(out["status"], "hit")
        self.assertEqual(out["text"], "Orange : Compte recharge : 1.234 DT\nTunisie Télécom : Principal : 5.678 DT")
        self.assertNotIn("6.912", out["text"])

    def test_partial_result_preserves_success_and_failed_outcome(self):
        rows = self.rows()
        rows[1] = {"label": "Tunisie Télécom", "state": "unavailable", "reason": "selected_not_ready"}
        out = self.execute("partial", rows)
        self.assertEqual(out["status"], "known_error")
        self.assertEqual(out["execution_state"], "partial")
        self.assertIn("1.234 DT", out["text"])
        self.assertIn("Tunisie Télécom : Lecture indisponible.", out["text"])

    def test_uncertainty_and_not_started_are_explicit(self):
        out = self.execute("indeterminate", [{"label": "Orange", "state": "indeterminate"},
                                             {"label": "Tunisie Télécom", "state": "not_started"}])
        self.assertEqual(out["status"], "known_error")
        self.assertIn("non rejouée", out["text"])
        self.assertIn("Lecture non exécutée", out["text"])

    def test_false_domain_success_does_not_render_as_value(self):
        payload = {"strategy": "composed_read", "results": [{"label": "Orange", "state": "completed",
                   "result": {"ok": False, "text": "unverified balance"}}]}
        self.assertEqual(module._display_text(payload), "Orange : Lecture indisponible.")

    def test_existing_payment_and_single_read_display_unchanged(self):
        for value in ({"text": "Paiement préparé"}, {"ok": True, "message": "Solde Orange"}):
            before = copy.deepcopy(value)
            self.assertEqual(module._display_text(value), value.get("text") or value["message"])
            self.assertEqual(value, before)


if __name__ == "__main__":
    unittest.main()
