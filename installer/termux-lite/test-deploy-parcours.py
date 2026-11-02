#!/usr/bin/env python3
"""deploy-parcours.py verdicts on replies captured on the S24 (29/10 23:00 Tunis, Pulse closed), no network."""
import importlib.util, json, sqlite3, tempfile, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("parcours", Path(__file__).with_name("deploy-parcours.py"))
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)

# Captured on the S24 with the owner session and the « Recette Pulse » contact.
OWNER_READ = "Ton agenda est libre demain, vendredi 30 octobre : aucun événement prévu."
CLOSED = ("Pulse est fermé en ce moment (ouvert du lundi au vendredi de 9:00 à 19:00, heure de Tunis). "
          "Réessaie demain à partir de 9:00.")
RECAP = ("Confirme cette action :\nAjouter ce rendez-vous à ton agenda Google.\nTitre : Recette déploiement\n"
         "Début : 2026-10-30T10:00:00+01:00\nConfirmer ?")
# S24 31/10 12:02: revoked Google token during owner_read (real tool result, see the fixture provenance).
AUTH = json.loads((Path(__file__).resolve().parents[2] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-31-agenda-auth-revoked/"
                   "parcours-owner-read.json").read_text())
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

    def test_refused_typed_tool_is_broken(self):
        # Captured on the S24 30/10 23:57 Tunis (deployment dbe0f455, typed agenda calls refused by the guard).
        read = "Je ne peux pas vérifier ton agenda pour l’instant : l’accès Agenda est momentanément indisponible."
        write = ("Je ne peux pas préparer l’ajout pour l’instant : l’accès Agenda est momentanément indisponible. "
                 "Aucun rendez-vous n’a été créé.")
        self.assertEqual(p.verdict("owner_read", read, None), ("failed", "broken_reply"))
        self.assertEqual(p.verdict("write_recap", write, None), ("failed", "broken_reply"))

    def test_history_bound_refusal_is_broken(self):
        # S24 31/10 00:57 Tunis, reused session: no tool call, the brain repeated the previous refusal.
        self.assertEqual(p.verdict("owner_read", "Je ne peux toujours pas consulter ton agenda : l’accès Agenda est "
                                   "indisponible pour le moment.", None), ("failed", "broken_reply"))
        self.assertEqual(p.verdict("write_recap", "Je ne peux pas préparer l’ajout : l’accès Agenda est toujours "
                                   "indisponible. Aucun rendez-vous n’a été créé ni mis en attente.", None),
                         ("failed", "broken_reply"))

    def test_each_run_uses_a_fresh_owner_session(self):
        keys = []
        def run(args, **kw):
            keys.append(args[args.index("--session-key") + 1])
            class P: stdout = json.dumps({"status": "ok", "result": {"payloads": [{"text": "ok"}]}}); returncode = 0
            return P()
        import functools, time as t
        for stamp in ((2026, 10, 31, 0, 50, 19, 4, 304, 0), (2026, 10, 31, 1, 20, 2, 4, 304, 0)):
            key = p.fresh_owner_session(lambda: t.struct_time(stamp))
            p.owner_turn("x", run=run, session=key)
        self.assertEqual(keys, ["agent:main:recette-deploy:20261031T005019Z", "agent:main:recette-deploy:20261031T012002Z"])

    def test_outage_is_inconclusive_never_a_rollback(self):
        self.assertEqual(p.verdict("owner_read", "", "429 rate limit"), ("inconclusive", "provider_unavailable"))
        self.assertEqual(p.verdict("contact_read", "Le modèle n’est pas joignable pour le moment.", None),
                         ("inconclusive", "provider_unavailable"))


class ProviderAuthorization(unittest.TestCase):
    """S24 31/10 12:02: an expired/revoked Google access is the owner's action, never a candidate regression."""
    def transcript(self, rows, session="agent:main:recette-deploy:20261031T110200Z"):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        db = Path(directory.name) / "openclaw-agent.sqlite"
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, display_name TEXT, label TEXT)")
        conn.execute("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at TEXT)")
        conn.execute("INSERT INTO session_nodes VALUES (?, 's-1', NULL, NULL)", (session.lower(),))
        conn.executemany("INSERT INTO transcript_events VALUES (?, ?, ?, '')",
                         [(sid, n, json.dumps(event, ensure_ascii=False)) for n, (sid, event) in enumerate(rows)])
        conn.commit(); conn.close()
        return p.TurnCauses(session, db)

    @staticmethod
    def tool_result(result, name="samantha_agenda"):
        return {"type": "message", "message": {"role": "toolResult", "toolName": name, "isError": False,
                                               "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]}}

    def test_s24_generic_reply_with_the_receipt_cause_is_inconclusive(self):
        causes = self.transcript([("s-1", self.tool_result(AUTH["tool_result"]))])
        cause = causes.cause(0)
        self.assertEqual(cause, "google_authorization_unavailable")
        self.assertEqual(p.verdict("owner_read", AUTH["owner_reply"], None, cause),
                         ("inconclusive", "provider_authorization_expired"))
        # Without the receipt the generic sentence stays a broken path (it is not a reliable signal alone).
        self.assertEqual(p.verdict("owner_read", AUTH["owner_reply"], None), ("failed", "broken_reply"))

    def test_named_sentence_is_inconclusive_unless_the_receipt_contradicts_it(self):
        fixed = AUTH["owner_reply_after_playbooks_fix"]
        for cause in (None, "google_authorization_revoked", "google_authorization_unavailable"):
            with self.subTest(cause=cause):
                self.assertEqual(p.verdict("owner_read", fixed, None, cause), ("inconclusive", "provider_authorization_expired"))
        for reworded in ("Ton accès Google a expiré, il faut reconnecter ton agenda Google.",
                         "Ton agenda Google n’est pas connecté : il faut le reconnecter.",
                         "Je ne peux pas l’ajouter : l’accès à ton agenda Google a été révoqué."):
            with self.subTest(reworded=reworded):
                self.assertEqual(p.verdict("write_recap", reworded, None), ("inconclusive", "provider_authorization_expired"))
        # The turn's typed tool results were read and name no such cause: an unfounded claim fails.
        self.assertEqual(p.verdict("owner_read", fixed, None, "other"), ("failed", "unconfirmed_provider_authorization"))
        # Ordinary failures keep their verdict; a provider outage keeps its own reason.
        self.assertEqual(p.verdict("owner_read", "", None, "google_authorization_revoked"), ("failed", "empty_reply"))
        self.assertEqual(p.verdict("owner_read", "", "TimeoutExpired", "google_authorization_revoked"), ("failed", "path_error"))
        self.assertEqual(p.verdict("owner_read", OWNER_READ, None, "other"), ("passed", "ok"))
        self.assertEqual(p.verdict("owner_read", "Le modèle n’est pas joignable.", None, "google_authorization_revoked"),
                         ("inconclusive", "provider_unavailable"))

    def test_turn_causes_read_only_this_turn(self):
        other_session = self.tool_result(AUTH["tool_result"])
        completed = self.tool_result({"state": "COMPLETED", "facts": {"state": "completed", "events": []}})
        causes = self.transcript([("s-1", self.tool_result(AUTH["tool_result"])), ("s-2", other_session),
                                  ("s-1", completed), ("s-1", {"message": {"role": "assistant", "content": "x"}})])
        # The earlier turn's failure (rowid 1) is not this turn's; this turn's completed read names no cause.
        self.assertEqual(causes.cause(1), "other")
        self.assertEqual(causes.cause(0), "google_authorization_unavailable")
        self.assertEqual(causes.cause(3), None)
        self.assertEqual(causes.mark(), 4)
        self.assertIsNone(causes.cause(None))
        # Non-typed tools, failures with another cause, unreadable rows: never an authorization.
        causes = self.transcript([("s-1", self.tool_result(AUTH["tool_result"], name="exec")),
                                  ("s-1", self.tool_result({"state": "FAILED", "facts": {"reason": "calendar_outcome_unverified"}})),
                                  ("s-1", {"message": {"role": "toolResult", "toolName": "samantha_agenda", "content": "not json"}})])
        self.assertEqual(causes.cause(0), "other")
        missing = p.TurnCauses("agent:main:recette-deploy:x", Path(tempfile.gettempdir()) / "absent-parcours.sqlite")
        self.assertEqual((missing.mark(), missing.cause(0)), (None, None))

    def test_refused_typed_admission_fails_whatever_the_sentence(self):
        # S24 02/11 09:44 UTC, deploy 20e36415 (PR #516), recette transcript agent:main:recette-deploy:20261102t084441z:
        # both agenda calls refused by the guard; owner_read was judged passed on the generic sentence.
        refused = {"state": "unverified", "reason": "typed_host_admission_required",
                   "answer": "Je n'ai pas de résultat vérifié pour cette action. Vérifie son état avant tout nouvel essai."}
        causes = self.transcript([("s-1", self.tool_result(refused))])
        cause = causes.cause(0)
        self.assertEqual(cause, "typed_host_admission_required")
        self.assertEqual(p.verdict("owner_read", refused["answer"], None, cause), ("failed", "typed_admission_refused"))
        self.assertEqual(p.verdict("write_recap", "D’accord, je ne relance pas l’ajout.", None, cause),
                         ("failed", "typed_admission_refused"))
        # Before this fix the same reply passed: the sentence alone is not a reliable signal.
        self.assertEqual(p.verdict("owner_read", refused["answer"], None), ("passed", "ok"))
        # A provider outage keeps its own verdict.
        self.assertEqual(p.verdict("owner_read", "Le modèle n’est pas joignable.", None, cause), ("inconclusive", "provider_unavailable"))

    def test_run_names_the_reason_and_never_masks_another_failure(self):
        class Causes:
            def __init__(self, found): self.found, self.turn = list(found), 0
            def mark(self): self.turn += 1; return self.turn
            def cause(self, mark): return self.found[mark - 1]
        owner = lambda replies: (lambda text: (replies.pop(0), 1.0, None))
        room = lambda replies: (lambda text: (replies.pop(0), 1.0, None))
        report = p.run_all(owner([AUTH["owner_reply"], RECAP, "ok"]), room([CLOSED, CLOSED, CLOSED]),
                           lambda: ([200, 200, 200], 0.1), Causes(["google_authorization_unavailable", "other"]))
        self.assertEqual(report["state"], "inconclusive")
        self.assertEqual(report["paths"][0], {"path": "owner_read", "state": "inconclusive",
                                              "reason": "provider_authorization_expired", "seconds": 1.0})
        self.assertEqual(report["paths"][3]["state"], "passed")
        # Another path broken for another reason still fails the run (the caller rolls back).
        report = p.run_all(owner([AUTH["owner_reply"], RECAP, "ok"]), room([CLOSED, GENERIC, CLOSED]),
                           lambda: ([200, 200, 200], 0.1), Causes(["google_authorization_unavailable", "other"]))
        self.assertEqual(report["state"], "failed")
        self.assertNotIn("agenda", json.dumps(report))


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
