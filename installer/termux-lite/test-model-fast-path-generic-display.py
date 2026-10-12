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

    def test_sensitive_or_failed_results_keep_the_safe_fallback(self):
        self.assertEqual(FALLBACK, m._display_text({"ok": True, "token": "Bearer abcdefghijklmnop", "phone": "+21612345678"}))
        self.assertEqual(FALLBACK, m._display_text({"ok": False, "reason": "x"}))

    def test_declared_text_still_wins(self):
        self.assertEqual("Solde : 16 j", m._display_text({"ok": True, "text": "Solde : 16 j", "balance": {"a": 1}}))


if __name__ == '__main__':
    unittest.main()
