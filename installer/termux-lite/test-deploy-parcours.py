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


def row(reply="", state="", reason="", facts=False, error=None, granted=False, helper_calls=None):
    return {"reply": reply, "state": state, "reasonCode": reason, "facts": facts, "seconds": 1.0, "error": error,
            "granted": granted, "helperCalls": helper_calls}


# The room brain's own sentences (roomBrain.ts) and the playbooks room owner's question for a creation.
# Recette 03/11: the Pulse subjects are derived from the room's actions (roomBrain.ts pulseSubjects); the verdict reads the prefix.
REFUSAL = ("Ici je ne traite que Pulse : projets, offres, chiffre d'affaires, évaluations, CRA, congés de l'équipe et solde de "
           "congés. Pour le reste, vois directement avec Amine.")
LEAVE = ("Désolé, je ne peux pas prendre en compte les demandes de congé : j’utilise le compte Pulse d’Amine, donc un congé "
         "posé ici serait enregistré au nom d’Amine. Merci de poser ta demande de congé directement dans Pulse, avec ton propre compte.")
ACCESS = "L’accès à la pièce Pulse n’est pas confirmé. Rien n’a été exécuté."
ASK = "Pour créer le projet, il me manque : le nom, le client et la date de fin. Peux-tu me les donner ?"
# Amine 02/11, contact rooms brain: the generic room session (contacts-agenda-actions-messages) of the same contact.
GENERIC_REFUSAL = ("Ici je ne traite que l’agenda d’Amine, les réglages et actions courantes de son téléphone et l’envoi de "
                   "messages WhatsApp en son nom. Pour le reste, vois directement avec Amine.")
ACTIONS_ACCESS = "L’accès à la pièce Actions n’est pas confirmé. Rien n’a été exécuté."
ROOM_OK = {"contact_read": row("", "COMPLETED", facts=True), "incomplete_ask": row(ASK, "NEEDS_INPUT"),
           "room_write_prepared": row("", "PREPARED", "CANCELLED"), "room_outside": row(REFUSAL, "OUTSIDE_SCOPE", "scope_outside"),
           "room_leave_refused": row(LEAVE, "DENIED", "scope_leave_request"),
           "room_generic_tools": row("", "TOOLS", "samantha_agenda,samantha_device_assistance,samantha_whatsapp"),
           # S24 02/11: no generic room granted to the recette contact, so the real grant read closes the room.
           "room_generic_read": row(ACTIONS_ACCESS, "DENIED", "room_grant_revoked", helper_calls=0),
           "room_generic_outside": row(GENERIC_REFUSAL, "OUTSIDE_SCOPE", "scope_outside", helper_calls=0)}


class RoomVerdicts(unittest.TestCase):
    """The room brain paths (Amine 02/11): fixed typed calls through the deployed room tool or owner."""
    def test_expected_outcomes_pass(self):
        for path, value in ROOM_OK.items():
            self.assertEqual(p.room_verdict(path, value)[0], "passed", path)
        for path in ("contact_read", "incomplete_ask", "room_write_prepared"):
            self.assertEqual(p.room_verdict(path, row(CLOSED, "TECHNICAL_FAILURE", "service_closed")), ("passed", "pulse_closed"))
        self.assertEqual(p.room_verdict("room_write_prepared", row(ASK, "NEEDS_CHOICE")), ("passed", "asked_before_prepare"))

    def test_a_write_that_ran_or_a_broken_room_fails(self):
        self.assertEqual(p.room_verdict("room_write_prepared", row("Phase mise à jour.", "COMPLETED")), ("failed", "write_not_stopped"))
        self.assertEqual(p.room_verdict("room_write_prepared", row("", "PREPARED", "COMPLETED")), ("failed", "write_not_stopped"))
        self.assertEqual(p.room_verdict("contact_read", row(ACCESS, "DENIED", "room_grant_revoked")), ("failed", "room_admission_refused"))
        self.assertEqual(p.room_verdict("contact_read", row("", "COMPLETED")), ("failed", "no_verified_result"))
        self.assertEqual(p.room_verdict("contact_read", row(GENERIC, "TECHNICAL_FAILURE")), ("failed", "broken_reply"))
        self.assertEqual(p.room_verdict("incomplete_ask", row("Projet créé.", "COMPLETED")), ("failed", "no_question"))
        self.assertEqual(p.room_verdict("room_outside", row("Il fait beau.", "COMPLETED")), ("failed", "not_refused"))
        self.assertEqual(p.room_verdict("room_leave_refused", row(REFUSAL, "DENIED", "scope_forbidden")), ("failed", "leave_not_refused"))
        self.assertEqual(p.room_verdict("room_outside", row(error="room_tool_unavailable")), ("failed", "path_error"))
        # The owner's own dry run refused the discovered target: nothing to judge, nothing written.
        self.assertEqual(p.room_verdict("room_write_prepared", row("x", "TECHNICAL_FAILURE", "pulse_preparation_failed")),
                         ("inconclusive", "write_not_prepared"))

    def test_generic_room_paths(self):
        # Amine 02/11, contact rooms brain: tools of the generic session, a read closed without a grant (or done by the
        # granted contact's own agent), another domain refused; a helper call without a grant is a regression.
        for path in ("room_generic_tools", "room_generic_read", "room_generic_outside"):
            self.assertEqual(p.room_verdict(path, ROOM_OK[path])[0], "passed", path)
        self.assertEqual(p.room_verdict("room_generic_read", ROOM_OK["room_generic_read"]), ("passed", "no_grant_refused"))
        self.assertEqual(p.room_verdict("room_generic_read", row("Batterie : 80 %.", "COMPLETED", granted=True)), ("passed", "ok"))
        self.assertEqual(p.room_verdict("room_generic_read", row("", "COMPLETED", granted=True, facts=True)), ("passed", "ok"))
        failures = (
            ("room_generic_tools", row("", "TOOLS", "samantha_agenda,samantha_pulse"), "room_tools_unexpected"),
            ("room_generic_tools", row("", "TOOLS", ""), "room_tools_unexpected"),
            ("room_generic_read", row("Batterie : 80 %.", "COMPLETED"), "room_not_closed"),
            ("room_generic_read", row(ACTIONS_ACCESS, "DENIED", "room_grant_revoked", helper_calls=1), "room_not_closed"),
            ("room_generic_read", row(ACTIONS_ACCESS, "DENIED", "room_grant_revoked", granted=True), "room_admission_refused"),
            ("room_generic_read", row("", "COMPLETED", granted=True), "no_verified_result"),
            ("room_generic_outside", row(REFUSAL, "OUTSIDE_SCOPE", "scope_outside", helper_calls=0), "not_refused"),
            ("room_generic_outside", row("Batterie : 80 %.", "COMPLETED", helper_calls=1), "not_refused"),
            ("room_generic_tools", row(error="room_tool_unavailable"), "path_error"),
        )
        for path, value, reason in failures:
            self.assertEqual(p.room_verdict(path, value), ("failed", reason), (path, value))

    def test_runner_argv_is_one_fixed_typed_call(self):
        seen = []
        def run(argv, **kw):
            seen.append(argv)
            class P: stdout = json.dumps({"reply": REFUSAL, "state": "OUTSIDE_SCOPE", "reasonCode": "scope_outside", "facts": False}); returncode = 0
            return P()
        out = p.room_turn("tool", "agenda.read", {}, run=run)
        self.assertEqual(seen[0][2:], ["tool", "agenda.read", "{}"])
        self.assertEqual(p.room_verdict("room_outside", out), ("passed", "ok"))
        p.room_turn("prepare-first-project", None, {"phase": "Réalisation", "state": "started"}, run=run)
        self.assertEqual(seen[1][2:], ["prepare-first-project", '{"phase": "Réalisation", "state": "started"}'])
        self.assertTrue(all(m in ("tool", "prepare", "prepare-first-project", "generic-tools", "generic-read",
                                  "generic-outside") for _, m, _a, _p in p.ROOM_CALLS))
        p.room_turn("generic-read", None, {}, run=run)
        self.assertEqual(seen[2][2:], ["generic-read"], "a generic path takes no model or test input")
        # A write action is never sent through the tool mode (the tool would hand a complete write off).
        self.assertFalse([a for _, m, a, _p in p.ROOM_CALLS if m == "tool" and a in ("project.create", "project.phase.set_status")])

    def test_room_tools_reads_the_closed_policy(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        config = Path(directory.name) / "openclaw.json"
        before = json.loads((Path(__file__).resolve().parents[2] / "openclaw-plugin-mobile-ui/fixtures/"
                             "s24-2026-11-02-pulse-room-brain/room-grant-recette.json").read_text())["agent_tools_before"]
        config.write_text(json.dumps({"agents": {"entries": {n: {"tools": t} for n, t in before.items()}}}))
        self.assertEqual(p.room_tools(config)["reason"], "room_tools_not_closed")  # S24 02/11, before provision
        spec = importlib.util.spec_from_file_location("pulse_room", Path(__file__).with_name("pulse-room.py"))
        owner = importlib.util.module_from_spec(spec); spec.loader.exec_module(owner)
        config.write_text(json.dumps({"agents": {"entries": {n: {"tools": owner.room_tools(n, t)} for n, t in before.items()}}}))
        self.assertEqual(p.room_tools(config)["state"], "passed")
        # Amine 02/11: every typed room agent present is checked too (none on the S24 on 02/11); Projet-only is not.
        rooms = json.loads((Path(__file__).resolve().parents[2] / "openclaw-plugin-mobile-ui/fixtures/"
                            "s24-2026-11-02-contact-rooms-brain/room-tools.json").read_text())["room_agents"]
        entries = {n: {"tools": v["tools"]} for n, v in rooms.items()}
        self.assertEqual(p.room_tools(self.write(config, entries))["state"], "passed", "the S24 room agents of 02/11")
        entries["contacts-agenda-actions"] = {"tools": rooms["contacts"]["tools"]}
        self.assertEqual(p.room_tools(self.write(config, entries))["reason"], "room_tools_not_closed")
        entries["contacts-agenda-actions"] = {"tools": owner.room_tools("contacts-agenda-actions", rooms["contacts"]["tools"])}
        self.assertEqual(p.room_tools(self.write(config, entries))["state"], "passed")

    @staticmethod
    def write(config, entries):
        config.write_text(json.dumps({"agents": {"entries": entries}}))
        return config


class Verdicts(unittest.TestCase):
    def test_captured_replies(self):
        self.assertEqual(p.verdict("owner_read", OWNER_READ, None), ("passed", "ok"))
        self.assertEqual(p.verdict("write_recap", RECAP, None), ("passed", "ok"))

    def test_open_hours_and_failures(self):
        self.assertEqual(p.verdict("write_recap", "C’est fait, rendez-vous ajouté.", None), ("failed", "not_stopped_at_recap"))
        self.assertEqual(p.verdict("write_recap", "Confirme : rendez-vous ajouté ?", None), ("failed", "not_stopped_at_recap"))
        self.assertEqual(p.verdict("owner_read", "", None), ("failed", "empty_reply"))
        self.assertEqual(p.verdict("owner_read", "", "TimeoutExpired"), ("failed", "path_error"))

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
        self.assertEqual(p.room_verdict("contact_read", row("Le modèle n’est pas joignable pour le moment.")),
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

    def test_typed_technical_failure_fails_the_path(self):
        # S24 02/11 recette agent:main:recette-deploy:20261102t104844z: route agenda.google.connector open since 01/11,
        # samantha_agenda agenda.event.read → TECHNICAL_FAILURE without facts; owner_read was judged passed.
        broken = {"state": "TECHNICAL_FAILURE", "receiptId": None, "facts": {},
                  "answer": "Cette action est reconnue, mais elle n'est pas disponible pour le moment.", "replayed": False}
        cause = self.transcript([("s-1", self.tool_result(broken))]).cause(0)
        self.assertEqual(cause, "typed_technical_failure")
        self.assertEqual(p.verdict("owner_read", OWNER_READ, None, cause), ("failed", "typed_technical_failure"))
        # A named provider authorization keeps its own (inconclusive) verdict.
        named = {"state": "TECHNICAL_FAILURE", "facts": {"reason": "google_authorization_unavailable"}}
        self.assertEqual(self.transcript([("s-1", self.tool_result(named))]).cause(0), "google_authorization_unavailable")
        # A completed read after it is not this turn's failure once marked.
        ok = {"state": "COMPLETED", "facts": {"state": "completed", "events": []}}
        self.assertEqual(self.transcript([("s-1", self.tool_result(ok))]).cause(0), "other")

    def test_run_names_the_reason_and_never_masks_another_failure(self):
        class Causes:
            def __init__(self, found): self.found, self.turn = list(found), 0
            def mark(self): self.turn += 1; return self.turn
            def cause(self, mark): return self.found[mark - 1]
        owner = lambda replies: (lambda text: (replies.pop(0), 1.0, None))
        room = lambda broken=None: (lambda mode, action, params: row(GENERIC, "TECHNICAL_FAILURE") if broken else ROOM_OK[
            next(path for path, m, a, _p in p.ROOM_CALLS if (m, a) == (mode, action))])
        tools = lambda: {"path": "room_tools", "state": "passed", "reason": "ok", "seconds": 0.1}
        report = p.run_all(owner([AUTH["owner_reply"], RECAP, "ok"]), room(), lambda: ([200, 200, 200], 0.1),
                           Causes(["google_authorization_unavailable", "other"]), tools)
        self.assertEqual(report["state"], "inconclusive")
        self.assertEqual(report["paths"][0], {"path": "owner_read", "state": "inconclusive",
                                              "reason": "provider_authorization_expired", "seconds": 1.0})
        self.assertEqual(next(r for r in report["paths"] if r["path"] == "write_recap")["state"], "passed")
        # Another path broken for another reason still fails the run (the caller rolls back).
        report = p.run_all(owner([AUTH["owner_reply"], RECAP, "ok"]), room(True), lambda: ([200, 200, 200], 0.1),
                           Causes(["google_authorization_unavailable", "other"]), tools)
        self.assertEqual(report["state"], "failed")
        self.assertNotIn("agenda", json.dumps(report))


class Run(unittest.TestCase):
    def run_with(self, owner_replies, room_rows=None, codes=(200, 200, 200), tools_state="passed"):
        sent = {"owner": [], "room": []}
        rows = dict(ROOM_OK, **(room_rows or {}))
        def owner(text):
            sent["owner"].append(text); return owner_replies.pop(0), 1.0, None
        def room(mode, action, params):
            sent["room"].append((mode, action, params))
            return rows[next(path for path, m, a, _p in p.ROOM_CALLS if (m, a) == (mode, action))]
        tools = lambda: {"path": "room_tools", "state": tools_state, "reason": "ok", "seconds": 0.1}
        return p.run_all(owner, room, lambda: (list(codes), 0.1), tools=tools), sent

    def test_order_cleanup_and_no_user_text_in_receipt(self):
        report, sent = self.run_with([OWNER_READ, RECAP, "D’accord, je ne l’ajoute pas."])
        self.assertEqual(report["state"], "passed")
        self.assertEqual([r["path"] for r in report["paths"]], list(p.PATHS))
        # The recap is cancelled, never confirmed; no room write is ever handed off.
        self.assertTrue(sent["owner"][-1].startswith("Annule"))
        self.assertFalse(any(t.strip().lower() in ("oui", "confirme") for t in sent["owner"]))
        self.assertEqual([c[0] for c in sent["room"]], ["tool", "prepare", "prepare-first-project", "tool", "tool",
                                                        "generic-tools", "generic-read", "generic-outside"])
        self.assertNotIn("agenda", json.dumps(report))
        self.assertNotIn("Pulse", json.dumps(report))

    def test_one_failure_fails_and_outage_is_inconclusive(self):
        report, _ = self.run_with([OWNER_READ, RECAP, "ok"], {"incomplete_ask": row(GENERIC, "TECHNICAL_FAILURE")})
        self.assertEqual(report["state"], "failed")
        report, _ = self.run_with([OWNER_READ, RECAP, "ok"], {"room_write_prepared": row("ok", "COMPLETED")})
        self.assertEqual(report["state"], "failed")
        report, _ = self.run_with([OWNER_READ, RECAP, "ok"], tools_state="failed")
        self.assertEqual(report["state"], "failed")
        report, _ = self.run_with([OWNER_READ, RECAP, "ok"], codes=(200, 503, 200))
        self.assertEqual(report["state"], "failed")
        report, _ = self.run_with([OWNER_READ, "Le modèle n’est pas joignable.", "ok"])
        self.assertEqual(report["state"], "inconclusive")


if __name__ == "__main__":
    unittest.main()
