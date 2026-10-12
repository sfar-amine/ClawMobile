#!/usr/bin/env python3
"""Amine 12/10 : tout résultat déterministe s'affiche en texte lisible, sans champ technique ni donnée sensible."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fast_path_display', Path(__file__).with_name('model-fast-path.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
FALLBACK = "Résultat disponible auprès de Claw ; détails non affichables en texte."


class GenericDisplayTests(unittest.TestCase):
    def test_leave_balance_and_rows(self):
        text = m._display_text({"ok": True, "balance": {"solde_a_date_jours": 16.427, "ytd_jours": 21},
                                "requests": [{"id": 15150, "type": "Congé Annuel", "start": "15/10/2026 09:00"}] * 7,
                                "latency_ms": {"total": 1485}})
        self.assertIn("Balance : solde a date jours : 16.427 ; ytd jours : 21", text)
        self.assertIn("Requests : 7\n- 15150 · Congé Annuel · 15/10/2026 09:00", text)
        self.assertTrue(text.endswith("- …")); self.assertNotIn("latency", text.lower())

    def test_forecast_and_empty_search(self):
        self.assertEqual("Offer id : 20447\nCharges : 2026-11 : 50\nTotal jh : 665",
                         m._display_text({"ok": True, "offer_id": "20447", "charges": {"2026-11": "50"}, "total_jh": 665, "route": "x"}))
        self.assertEqual("Project count : 0\nProjects : aucun",
                         m._display_text({"ok": True, "query": "zain", "project_count": 0, "projects": [], "request_count": 5}))

    def test_one_result_shows_its_whole_record(self):
        text = m._display_text({"ok": True, "project_count": 1, "projects": [{"project_id": "20495", "label": "ZAIN BAHRAIN - PHASE 5",
                                "status": "En attente du BC", "progress": "9%", "sold": "417"}]})
        self.assertEqual("Project count : 1\nProject id : 20495\nLabel : ZAIN BAHRAIN - PHASE 5\nStatus : En attente du BC\nProgress : 9%\nSold : 417", text)

    def test_tables_render_as_rows(self):
        text = m._display_text({"ok": True, "intent": "pulse.cra.status", "path": "/x", "filters": {},
                                "tables": [{"headers": ["Collaborateur", "Mois", "Statut"], "rows": [["Amal", "10/2026", "Validé"], ["Sami", "10/2026", "À saisir"]]}]})
        self.assertEqual("Tables : 2 ligne(s)\n- Collaborateur : Amal · Mois : 10/2026 · Statut : Validé\n- Collaborateur : Sami · Mois : 10/2026 · Statut : À saisir", text)

    def test_nested_values_and_bracketed_labels(self):
        text = m._display_text({"ok": True, "provider": "zain-bahrain", "workflow": "balance", "ui_used": True, "observed_at": 1.7e9,
                                "data": {"balance": {"value": "0.000", "unit": "BD"}}})
        self.assertEqual("Data : balance : 0.000 BD", text)
        self.assertEqual("Offer id : 20447\nOffer : [Offre] : SOTELMA · En cours",
                         m._display_text({"ok": True, "offer_id": "20447", "offer": "[Offre] : SOTELMA · En cours"}))
        month = {"period": "2026-01", "consumed_jh": {"displayed": "0"}, "progress": {"displayed": "0%"}}
        self.assertEqual("Period : 2026-01\nConsumed jh : 0\nProgress : 0%", m._display_text({"ok": True, "monthly": [month]}))
        self.assertEqual("Monthly : 2\n- 2026-01 · 0 · 0%\n- 2026-01 · 0 · 0%", m._display_text({"ok": True, "monthly": [month, month]}))
        self.assertEqual("Résultat disponible auprès de Claw ; détails non affichables en texte.", m._display_text({"ok": True, "raw": '[{"a":1}]'}))

    def test_sensitive_or_failed_results_keep_the_safe_fallback(self):
        self.assertEqual(FALLBACK, m._display_text({"ok": True, "token": "Bearer abcdefghijklmnop", "phone": "+21612345678"}))
        self.assertEqual(FALLBACK, m._display_text({"ok": False, "reason": "x"}))

    def test_declared_text_still_wins(self):
        self.assertEqual("Solde : 16 j", m._display_text({"ok": True, "text": "Solde : 16 j", "balance": {"a": 1}}))



class ChoiceTests(unittest.TestCase):
    """Amine 12/10 : plusieurs correspondances → une question avec la liste, rien n'est exécuté."""
    def test_executor_choice_becomes_a_held_clarification(self):
        clarify = {"type": "CLARIFY", "target": "pulse"}
        resolution = {"decision": {"type": "EXECUTE"}, "harness": {"tool_policy": "required"},
                      "selected": {"state": "ready", "authorized": True, "deterministic": True}}
        executed = {"decision": clarify, "execution": {"state": "needs_clarification", "question": "J'ai trouvé 2 projets : lequel ?",
                    "choices": [{"label": "20495 · ZAIN BAHRAIN - PHASE 5", "value": "20495"}, {"label": "18589 · ZAIN BAHRAIN - Wave 1", "value": "18589"}]}}
        old = (m.resolve_capability, m.execute_capability_decision)
        m.resolve_capability = lambda *a, **k: resolution
        m.execute_capability_decision = lambda *a, **k: executed
        try:
            out = m.try_fast_path("etat projet zain")
        finally:
            m.resolve_capability, m.execute_capability_decision = old
        self.assertEqual(("clarification", "choice_required"), (out["status"], out["reason"]))
        self.assertEqual(clarify, out["decision"])
        self.assertEqual("J'ai trouvé 2 projets : lequel ?\n- 20495 · ZAIN BAHRAIN - PHASE 5\n- 18589 · ZAIN BAHRAIN - Wave 1", out["text"])

    def test_closed_or_unanswering_service_says_so_never_an_error(self):
        """Amine 12/10 : Pulse est fermé de 19:00 à 9:00 et le week-end ; une demande dit ce qu'il en est."""
        resolution = {"decision": {"type": "EXECUTE"}, "harness": {"tool_policy": "required"},
                      "selected": {"state": "ready", "authorized": True, "deterministic": True}}
        old = (m.resolve_capability, m.execute_capability_decision)
        m.resolve_capability = lambda *a, **k: resolution
        try:
            for state, message in (
                ("service_closed", "Pulse est fermé en ce moment (ouvert du lundi au vendredi de 9:00 à 19:00, heure de Tunis). Réessaie demain à partir de 9:00."),
                ("service_unavailable", "Pulse ne répond pas pour le moment. Réessaie dans quelques minutes."),
                ("failed", "Pulse ne répond pas pour le moment. Réessaie dans quelques minutes."),
            ):
                m.execute_capability_decision = lambda *a, **k: {"decision": {"type": "EXECUTE"}, "execution": {"state": state, "message": message}}
                out = m.try_fast_path("état projet zain phase 5")
                self.assertEqual(("known_error", message), (out["status"], out["text"]), state)
                self.assertTrue(out["model_bypassed"])
        finally:
            m.resolve_capability, m.execute_capability_decision = old


class BridgeParityTests(unittest.TestCase):
    """Recette du 12/10 : les paramètres durables doivent hacher comme JSON.stringify côté Remote Bridge."""
    def test_integral_floats_are_encoded_like_javascript(self):
        import json, shutil, subprocess
        params = {"request": "état du téléphone", "caller": "owner", "decision": {"confidence": 1.0, "score": 0.99, "x": [1.0, 2.5], "ok": True, "none": None}}
        self.assertEqual({"confidence": 1, "score": 0.99, "x": [1, 2.5], "ok": True, "none": None}, m._js_json(params)["decision"])
        if not shutil.which("node"):
            self.skipTest("node absent")
        wire = json.dumps(m._js_json(params), ensure_ascii=False, separators=(",", ":"))
        js = subprocess.run(["node", "-e", "const c=require('crypto');process.stdout.write(c.createHash('sha256').update(JSON.stringify({method:'capability_execute_owner',params:JSON.parse(process.argv[1])})).digest('hex'))", wire],
                            capture_output=True, text=True, check=True).stdout
        self.assertEqual(js, m._bridge_params_hash("capability_execute_owner", params))

if __name__ == '__main__':
    unittest.main()
