#!/usr/bin/env python3
"""Deployment acceptance on five representative paths (Amine 29/10: at deploy time only, five paths, not every use case).

Runs after the runtime switch, against what really answers now: the Gateway with the synced plugin and the active
playbooks snapshot. Nothing is sent on WhatsApp and nothing is written:
  1. owner_read        owner brain (same agent as WhatsApp), dedicated session, an agenda read;
  2. contact_read      test contact « Recette Pulse » (fictitious number) in the Pulse room, a project list;
  3. incomplete_ask    same contact, an incomplete creation: Samantha must ask, never act;
  4. write_recap       owner brain, an agenda write that must stop at the confirmation recap, then cancelled;
  5. app_read          the Companion routes the app reads.
« Pulse est fermé » is a valid answer for 2 and 3. A provider outage is inconclusive (a rollback would not fix it), and so
is an external provider authorization to redo (Google access expired or revoked): the owner reconnects, the candidate
is not at fault (S24 31/10 12:02). That cause is read from the typed tool result of the turn when the agent transcript
is readable; otherwise from the owner sentence alone.

Exit 0 = passed, 1 = a path failed (the caller rolls back), 3 = inconclusive (provider unavailable or provider
authorization to redo), 2 = usage.
One JSON object on stdout: the receipt section."""
import functools, json, os, re, sqlite3, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPANION = "http://127.0.0.1:8765/v1"
# One fresh owner session per run (S24 31/10 00:57: the reused session kept a refused agenda call of the previous
# deployment and the brain answered « toujours indisponible » without calling the tool, so the run judged history).
OWNER_SESSION = "agent:main:recette-deploy"
ROOM_RUNNER = HERE / "deploy-parcours-room.cjs"
OWNER_TIMEOUT_S, ROOM_TIMEOUT_S = 150, 90
CLOSED = re.compile(r"Pulse est fermé")
# Sentences that only a broken path renders (core FAILURE_PHRASES / room fallbacks).
BROKEN = re.compile(r"n’a pas abouti|n'a pas abouti|pas confirmé|n’est pas établi|n'est pas établi|reste à vérifier|"
                    r"n’ai pas pu|n'ai pas pu|erreur interne|Rien n’a été exécuté\.$|"
                    # S24 30/10 dbe0f455: a refused typed tool call rendered as this (owner_read passed by mistake).
                    r"est (?:momentanément |toujours )?indisponible")
# A provider outage: inconclusive, never a rollback.
OUTAGE = re.compile(r"modèle n’est pas joignable|modèle n'est pas joignable|interpretation_unavailable|"
                    r"rate.?limit|overloaded|429|503 Service", re.I)
# An external provider authorization the owner must redo (S24 31/10 12:02: revoked Google token, owner_read classified
# broken_reply and an unrelated playbooks PR refused). Inconclusive, never a rollback.
# Typed tool causes: samantha-ui-playbooks agenda/google_sdk.py AUTHORIZATION_REASONS.
PROVIDER_AUTHORIZATION = frozenset({"google_authorization_required", "google_authorization_unavailable",
                                    "google_authorization_revoked", "google_authorization_storage_permissions",
                                    "google_tasks_authorization_required"})
# Owner sentences of the same causes (samantha-ui-playbooks agenda/presentation.py FAILURES), and close rewordings.
AUTHORIZATION_REPLY = re.compile(
    r"(?:agenda|accès|compte) Google[^.]{0,40}(?:a expiré|est expiré|a été révoqué|n[’']est pas connecté)"
    r"|Google Tasks n[’']est pas autorisé|reconnect\w* (?:ton |l[’'])?(?:agenda|accès|compte) Google", re.I)
OWNER_TRANSCRIPT = Path.home() / ".openclaw/agents/main/agent/openclaw-agent.sqlite"
TYPED_ADMISSION_REFUSED = "typed_host_admission_required"
DONE_WRITE = re.compile(r"\b(ajouté|créé|enregistré|c’est fait|c'est fait)\b", re.I)
PATHS = ("owner_read", "contact_read", "incomplete_ask", "write_recap", "app_read")


def fresh_owner_session(now=time.gmtime):
    return OWNER_SESSION + ":" + time.strftime("%Y%m%dT%H%M%SZ", now())


def owner_turn(text, run=subprocess.run, session=OWNER_SESSION):
    """One owner-brain turn through the Gateway, no delivery: (text, seconds, error)."""
    began = time.monotonic()
    try:
        p = run(["openclaw", "agent", "--agent", "main", "--session-key", session, "--message", text,
                 "--json", "--timeout", str(OWNER_TIMEOUT_S - 20)],
                capture_output=True, text=True, timeout=OWNER_TIMEOUT_S)
        value = json.loads(p.stdout or "{}")
        payloads = (value.get("result") or {}).get("payloads") or []
        reply = " ".join(str(x.get("text") or "") for x in payloads if isinstance(x, dict)).strip()
        error = None if value.get("status") == "ok" else str(value.get("error") or value.get("status") or p.returncode)[:200]
        return reply, time.monotonic() - began, error
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return "", time.monotonic() - began, type(e).__name__


def _text(content):
    if isinstance(content, str):
        return content
    return "\n".join(str(x.get("text")) for x in content or [] if isinstance(x, dict) and isinstance(x.get("text"), str))


class TurnCauses:
    """Typed tool causes of one owner turn, read-only from the agent transcript (the store claw-live.py reads:
    session_nodes.session_key -> current_session_id, transcript_events.event_json « toolResult » messages).
    Never raises; an unreadable transcript means « unknown » and the sentence decides."""
    def __init__(self, session, db=OWNER_TRANSCRIPT):
        self.session, self.db = session, Path(db)

    def _connect(self):
        return sqlite3.connect("file:" + str(self.db) + "?mode=ro", uri=True, timeout=2)

    def mark(self):
        try:
            conn = self._connect()
            try:
                return int(conn.execute("SELECT COALESCE(MAX(rowid),0) FROM transcript_events").fetchone()[0])
            finally:
                conn.close()
        except (sqlite3.Error, OSError, TypeError, ValueError):
            return None

    def cause(self, after):
        """A PROVIDER_AUTHORIZATION reason named by a failed samantha_* tool result of this turn; « other » when
        this turn has typed tool results naming none; None when unknown (no mark, transcript or tool result)."""
        if after is None:
            return None
        try:
            conn = self._connect()
            try:
                row = conn.execute("SELECT current_session_id FROM session_nodes WHERE lower(session_key)=lower(?) "
                                   "LIMIT 1", (self.session,)).fetchone()
                rows = conn.execute("SELECT event_json FROM transcript_events WHERE session_id=? AND rowid>? "
                                    "ORDER BY rowid LIMIT 400", (row[0], after)).fetchall() if row else []
            finally:
                conn.close()
        except (sqlite3.Error, OSError):
            return None
        seen = False
        for (raw,) in rows:
            try:
                message = json.loads(raw or "{}").get("message")
                if (not isinstance(message, dict) or message.get("role") != "toolResult"
                        or not str(message.get("toolName") or "").startswith("samantha_")):
                    continue
                result = json.loads(_text(message.get("content")))
            except (ValueError, AttributeError, TypeError):
                continue
            # S24 02/11 09:44 UTC (deploy 20e36415): the guard refused every typed call; the brain answered with the
            # generic « pas de résultat vérifié » sentence, which no reply pattern names. A refused admission is
            # the candidate's own regression, whatever the sentence.
            if isinstance(result, dict) and result.get("reason") == TYPED_ADMISSION_REFUSED:
                return TYPED_ADMISSION_REFUSED
            if not isinstance(result, dict) or not isinstance(result.get("facts"), dict):
                continue
            seen = True
            reason = result["facts"].get("reason")
            if result.get("state") != "COMPLETED" and reason in PROVIDER_AUTHORIZATION:
                return reason
        return "other" if seen else None


def room_turn(text, run=subprocess.run):
    """One Recette Pulse message through the deployed room hook, no delivery: (text, seconds, error)."""
    began = time.monotonic()
    try:
        p = run(["node", str(ROOM_RUNNER), text], capture_output=True, text=True, timeout=ROOM_TIMEOUT_S)
        value = json.loads((p.stdout or "{}").strip().splitlines()[-1])
        return str(value.get("reply") or ""), time.monotonic() - began, value.get("error")
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired) as e:
        return "", time.monotonic() - began, type(e).__name__


def app_read(get=None):
    get = get or (lambda path: urllib.request.urlopen(urllib.request.Request(
        COMPANION + path, headers={"x-clawmobile-owner-flow": "v1"}), timeout=10).status)
    began = time.monotonic()
    try:
        codes = [get(path) for path in ("/health", "/catalog", "/runs?limit=40&summary=1")]
    except (OSError, urllib.error.URLError, ValueError):
        codes = [0]
    return codes, time.monotonic() - began


def verdict(path, text, error, cause=None):
    """'passed' | 'failed' | 'inconclusive' and a short reason (no user text in the receipt).

    ``cause``: TurnCauses.cause of an owner turn (a PROVIDER_AUTHORIZATION reason, « other » or None)."""
    if error and OUTAGE.search(str(error)) or OUTAGE.search(text):
        return "inconclusive", "provider_unavailable"
    if error:
        return "failed", "path_error"
    if cause == TYPED_ADMISSION_REFUSED:
        return "failed", "typed_admission_refused"
    if not text.strip():
        return "failed", "empty_reply"
    # The typed tool result names a provider authorization to redo: whatever sentence the brain built on it
    # (the generic « n’a pas abouti » of an older playbooks included), the candidate cannot be judged on this path.
    if cause in PROVIDER_AUTHORIZATION:
        return "inconclusive", "provider_authorization_expired"
    if AUTHORIZATION_REPLY.search(text):
        # The sentence alone counts only when the turn's tool results are unknown; read and naming no such
        # cause, the claim is unfounded: a broken path, never a pass.
        return ("inconclusive", "provider_authorization_expired") if cause is None else ("failed", "unconfirmed_provider_authorization")
    if BROKEN.search(text):
        return "failed", "broken_reply"
    if path in ("contact_read", "incomplete_ask") and CLOSED.search(text):
        return "passed", "pulse_closed"
    if path == "incomplete_ask" and "?" not in text:
        return "failed", "no_question"
    if path == "write_recap" and (not re.search(r"Confirme", text) or "?" not in text or DONE_WRITE.search(text)):
        return "failed", "not_stopped_at_recap"
    return "passed", "ok"


def run_all(owner=None, room=room_turn, app=app_read, causes=None):
    session = fresh_owner_session()
    owner = owner or functools.partial(owner_turn, session=session)
    causes = causes or TurnCauses(session)
    rows = []
    def record(path, text, took, error, cause=None):
        state, reason = verdict(path, text, error, cause)
        rows.append({"path": path, "state": state, "reason": reason, "seconds": round(took, 1)})
    def judged_owner(path, text):
        mark = causes.mark()
        reply = owner(text)
        record(path, *reply, cause=causes.cause(mark))
    judged_owner("owner_read", "Qu'est-ce que j'ai dans mon agenda demain ?")
    record("contact_read", *room("Liste mes projets Pulse"))
    record("incomplete_ask", *room("Crée un nouveau projet"))
    room("Annule la demande en cours")  # leaves no open question for the next run; not judged
    judged_owner("write_recap", "Ajoute à mon agenda demain à 10h un rendez-vous intitulé Recette déploiement")
    owner("Annule, ne l'ajoute pas.")  # the recap is never confirmed; not judged
    codes, took = app()
    rows.append({"path": "app_read", "state": "passed" if codes and all(c == 200 for c in codes) else "failed",
                 "reason": "ok" if codes and all(c == 200 for c in codes) else "route_unavailable", "seconds": round(took, 1)})
    states = {r["state"] for r in rows}
    state = "failed" if "failed" in states else "inconclusive" if "inconclusive" in states else "passed"
    return {"state": state, "paths": rows}


def main(argv):
    if argv[1:]:
        print("usage: deploy-parcours.py", file=sys.stderr)
        return 2
    report = run_all()
    print(json.dumps(report, ensure_ascii=False))
    return {"passed": 0, "failed": 1, "inconclusive": 3}[report["state"]]


if __name__ == "__main__":
    sys.exit(main(sys.argv))
