#!/usr/bin/env python3
"""deploy-parcours.py verdicts on replies captured on the S24 (29/10 23:00 Tunis, Pulse closed), no network."""
import importlib.util, json, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("parcours", Path(__file__).with_name("deploy-parcours.py"))
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)

# Captured on the S24 with the owner session and the « Recette Pulse » contact.
OWNER_READ = "Ton agenda est libre demain, vendredi 30 octobre : aucun événement prévu."
CLOSED = ("Pulse est fermé en ce moment (ouvert du lundi au vendredi de 9:00 à 19:00, heure de Tunis). "
          "Réessaie demain à partir de 9:00.")
RECAP = ("Confirme cette action :\nAjouter ce rendez-vous à ton agenda Google.\nTitre : Recette déploiement\n"
         "Début : 2026-10-30T10:00:00+01:00\nConfirmer ?")
GENERIC = "La préparation ou la vérification de cette commande n’a pas abouti. Aucun nouvel essai automatique n’est lancé."


class Verdicts(unittest.TestCase):
    def test_captured_replies(self):
        self.assertEqual(p.verdict("owner_read", OWNER_READ, None), ("passed", "ok"))
        self.assertEqual(p.verdict("contact_read", CLOSED, None), ("passed", "pulse_closed"))
        self.assertEqual(p.verdict("incomplete_ask", CLOSED, None), ("passed", "pulse_closed"))
        self.assertEqual(p.verdict("write_recap", RECAP, None), ("passed", "ok"))
        # The S24 room rendered the closed-hours answer of a creation as this generic sentence (bug fixed with it).
        self.assertEqual(p.verdict("incomplete_ask", GENERIC, None), ("failed", "broken_reply"))

    def test_open_hours_and_failures(self):
        self.assertEqual(p.verdict("incomplete_ask", "Pour créer le projet, quel est le client ?", None), ("passed", "ok"))
        self.assertEqual(p.verdict("incomplete_ask", "Projet créé.", None), ("failed", "no_question"))
        self.assertEqual(p.verdict("write_recap", "C’est fait, rendez-vous ajouté.", None), ("failed", "not_stopped_at_recap"))
        self.assertEqual(p.verdict("write_recap", "Confirme : rendez-vous ajouté ?", None), ("failed", "not_stopped_at_recap"))
        self.assertEqual(p.verdict("owner_read", "", None), ("failed", "empty_reply"))
        self.assertEqual(p.verdict("contact_read", "", "TimeoutExpired"), ("failed", "path_error"))
        self.assertEqual(p.verdict("contact_read", "L’accès à la pièce Pulse n’est pas confirmé. Rien n’a été exécuté.", None),
                         ("failed", "broken_reply"))

    def test_outage_is_inconclusive_never_a_rollback(self):
        self.assertEqual(p.verdict("owner_read", "", "429 rate limit"), ("inconclusive", "provider_unavailable"))
        self.assertEqual(p.verdict("contact_read", "Le modèle n’est pas joignable pour le moment.", None),
                         ("inconclusive", "provider_unavailable"))


class Run(unittest.TestCase):
    def run_with(self, owner_replies, room_replies, codes=(200, 200, 200)):
        sent = {"owner": [], "room": []}
        def owner(text):
            sent["owner"].append(text); return owner_replies.pop(0), 1.0, None
        def room(text):
            sent["room"].append(text); return room_replies.pop(0), 1.0, None
        return p.run_all(owner, room, lambda: (list(codes), 0.1)), sent

    def test_order_cleanup_and_no_user_text_in_receipt(self):
        report, sent = self.run_with([OWNER_READ, RECAP, "D’accord, je ne l’ajoute pas."], [CLOSED, CLOSED, CLOSED])
        self.assertEqual(report["state"], "passed")
        self.assertEqual([r["path"] for r in report["paths"]], list(p.PATHS))
        # The recap is cancelled, never confirmed; the room question is closed for the next run.
        self.assertTrue(sent["owner"][-1].startswith("Annule"))
        self.assertFalse(any(t.strip().lower() in ("oui", "confirme") for t in sent["owner"]))
        self.assertTrue(sent["room"][-1].startswith("Annule"))
        self.assertNotIn("agenda", json.dumps(report))

    def test_one_failure_fails_and_outage_is_inconclusive(self):
        report, _ = self.run_with([OWNER_READ, RECAP, "ok"], [CLOSED, GENERIC, CLOSED])
        self.assertEqual(report["state"], "failed")
        report, _ = self.run_with([OWNER_READ, RECAP, "ok"], [CLOSED, CLOSED, CLOSED], codes=(200, 503, 200))
        self.assertEqual(report["state"], "failed")
        report, _ = self.run_with([OWNER_READ, "Le modèle n’est pas joignable.", "ok"], [CLOSED, CLOSED, CLOSED])
        self.assertEqual(report["state"], "inconclusive")


if __name__ == "__main__":
    unittest.main()
