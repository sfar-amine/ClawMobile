#!/usr/bin/env python3
"""Deployment acceptance on representative paths (Amine 29/10: at deploy time only, not every use case).

Runs after the runtime switch, against what really answers now: the Gateway with the synced plugin and the active
playbooks snapshot. Nothing is sent on WhatsApp and nothing is written:
  1. owner_read          owner brain (same agent as WhatsApp), dedicated session, an agenda read;
  2. room_tools          the two Pulse room agents: the room tool allowed, every other tool closed (openclaw.json);
  3. contact_read        test contact « Recette Pulse » (fictitious number) in the Pulse room, its room brain's
                         samantha_pulse tool (Amine 02/11), a project list;
  4. incomplete_ask      same contact, an incomplete creation: Samantha must ask, never act;
  5. room_write_prepared same contact, a complete phase status on its first project: prepared by the room owner, the
                         grant re-read, then closed before any Pulse write (the runner never sends the hand-off);
  6. room_outside        same contact, another domain's action: refused;
  7. room_leave_refused  same contact, a leave request: refused (Amine's Pulse account);
  8. room_generic_tools  same contact in a generic room session (agenda, actions, messages; Amine 02/11, contact rooms
                         brain): the deployed factory gives exactly those rooms' typed tools; every existing typed room
                         agent keeps its closed policy (room_tools above covers them all);
  9. room_generic_read   same contact, a read in a generic room: by its routed agent when it holds such a room, else
                         refused by the deployed room tool on the real grant read, with no typed helper call;
 10. room_generic_outside same generic session, another domain's action: refused before any read;
 11. write_recap         owner brain, an agenda write that must stop at the confirmation recap, then cancelled;
 12. app_read            the Companion routes the app reads.
« Pulse est fermé » is a valid answer for 3, 4 and 5. The room paths call the deployed room tool or its owner with one
fixed typed call each (deploy-parcours-room.cjs), never the model. A provider outage is inconclusive (a rollback would not fix it), and so
is an external provider authorization to redo (Google access expired or revoked): the owner reconnects, the candidate
is not at fault (S24 31/10 12:02). That cause is read from the typed tool result of the turn when the agent transcript
is readable; otherwise from the owner sentence alone.

Exit 0 = passed, 1 = a path failed (the caller rolls back), 3 = inconclusive (provider unavailable or provider
authorization to redo), 2 = usage.
One JSON object on stdout: the receipt section."""
import functools, importlib.util, json, os, re, sqlite3, subprocess, sys, time, urllib.error, urllib.request
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
TYPED_TECHNICAL_FAILURE = "typed_technical_failure"
DONE_WRITE = re.compile(r"\b(ajouté|créé|enregistré|c’est fait|c'est fait)\b", re.I)
PATHS = ("owner_read", "room_tools", "contact_read", "incomplete_ask", "room_write_prepared", "room_outside",
         "room_leave_refused", "room_generic_tools", "room_generic_read", "room_generic_outside", "write_recap", "app_read")
# One fixed typed call per room path (runner mode, action, params); see deploy-parcours-room.cjs.
ROOM_CALLS = (
    ("contact_read", "tool", "project.search", {}),
    ("incomplete_ask", "prepare", "project.create", {}),
    ("room_write_prepared", "prepare-first-project", None, {"phase": "Réalisation", "state": "started"}),
    ("room_outside", "tool", "agenda.read", {}),
    ("room_leave_refused", "tool", "leave.request", {"start_at": "2026-12-01", "end_at": "2026-12-02"}),
    ("room_generic_tools", "generic-tools", None, {}),
    ("room_generic_read", "generic-read", None, {}),
    ("room_generic_outside", "generic-outside", None, {}),
)
ROOM_AGENTS = ("contacts-pulse", "contacts-projet-pulse")
ROOM_REFUSAL = "Ici je ne traite que Pulse"
# The generic room session of the runner (contacts-agenda-actions-messages): its tools, its outside refusal.
GENERIC_TOOLS = "samantha_agenda,samantha_device_assistance,samantha_whatsapp"
GENERIC_REFUSAL = "Ici je ne traite que l’agenda d’Amine"
LEAVE_REFUSAL = "compte Pulse d’Amine"
OPENCLAW_CONFIG = Path.home() / ".openclaw/openclaw.json"


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
            # S24 01/11-02/11: the agenda read route stayed open after a closed Google incident; every read answered
            # TECHNICAL_FAILURE « reconnue, mais pas disponible » (no facts) and owner_read still passed on the
            # sentence for a day. A technical failure that names no provider authorization is a broken path.
            if (isinstance(result, dict) and result.get("state") == "TECHNICAL_FAILURE"
                    and (result.get("facts") or {}).get("reason") not in PROVIDER_AUTHORIZATION):
                return TYPED_TECHNICAL_FAILURE
            if not isinstance(result, dict) or not isinstance(result.get("facts"), dict):
                continue
            seen = True
            reason = result["facts"].get("reason")
            if result.get("state") != "COMPLETED" and reason in PROVIDER_AUTHORIZATION:
                return reason
        return "other" if seen else None


def room_turn(mode, action, params, run=subprocess.run):
    """One Recette Pulse typed call through the deployed room brain, no delivery: a row (reply, state, reasonCode,
    facts, seconds, error)."""
    began = time.monotonic()
    argv = ["node", str(ROOM_RUNNER), mode, *([action] if action else []),
            *([json.dumps(params, ensure_ascii=False)] if not mode.startswith("generic-") else [])]
    try:
        p = run(argv, capture_output=True, text=True, timeout=ROOM_TIMEOUT_S)
        value = json.loads((p.stdout or "{}").strip().splitlines()[-1])
        if not isinstance(value, dict):
            raise ValueError("room_runner_output")
        return {"reply": str(value.get("reply") or ""), "state": str(value.get("state") or ""),
                "reasonCode": str(value.get("reasonCode") or ""), "facts": value.get("facts") is True,
                "granted": value.get("granted") is True, "helperCalls": value.get("helperCalls"),
                "seconds": time.monotonic() - began, "error": value.get("error")}
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired) as e:
        return {"reply": "", "state": "", "reasonCode": "", "facts": False, "granted": False, "helperCalls": None,
                "seconds": time.monotonic() - began, "error": type(e).__name__}


def room_verdict(path, row):
    """'passed' | 'failed' | 'inconclusive' and a short reason for one room path (no user text in the receipt)."""
    reply, state, reason, error = row["reply"], row["state"], row["reasonCode"], row["error"]
    if error and OUTAGE.search(str(error)) or OUTAGE.search(reply):
        return "inconclusive", "provider_unavailable"
    if error:
        return "failed", "path_error"
    if path == "room_generic_tools":
        return ("passed", "ok") if state == "TOOLS" and reason == GENERIC_TOOLS else ("failed", "room_tools_unexpected")
    if path == "room_generic_outside":
        return (("passed", "ok") if state == "OUTSIDE_SCOPE" and reply.startswith(GENERIC_REFUSAL) and not row.get("helperCalls")
                else ("failed", "not_refused"))
    if path == "room_generic_read":
        if not row.get("granted"):
            # No generic room granted to the recette contact (S24 02/11): the real grant read must close the room.
            return (("passed", "no_grant_refused") if state == "DENIED" and reason == "room_grant_revoked"
                    and row.get("helperCalls") == 0 else ("failed", "room_not_closed"))
        if state == "COMPLETED" and (reply.strip() or row["facts"]) and not BROKEN.search(reply):
            return "passed", "ok"
        return "failed", "room_admission_refused" if reason == "room_grant_revoked" else "no_verified_result"
    if reason == "room_grant_revoked":
        return "failed", "room_admission_refused"
    if path in ("contact_read", "incomplete_ask", "room_write_prepared") and CLOSED.search(reply):
        return "passed", "pulse_closed"
    asked = state in ("NEEDS_INPUT", "NEEDS_CHOICE") and "?" in reply
    if path == "contact_read":
        if state == "COMPLETED" and (reply.strip() or row["facts"]) and not BROKEN.search(reply):
            return "passed", "ok"
        return "failed", "broken_reply" if BROKEN.search(reply) else "no_verified_result"
    if path == "incomplete_ask":
        return ("passed", "ok") if asked else ("failed", "no_question")
    if path == "room_write_prepared":
        if state == "COMPLETED":
            return "failed", "write_not_stopped"
        if state == "PREPARED":
            return ("passed", "prepared_stopped") if reason not in ("", "COMPLETED") else ("failed", "write_not_stopped")
        if asked:
            return "passed", "asked_before_prepare"
        if reason == "recette_no_project" or state == "TECHNICAL_FAILURE" and reason.startswith("pulse_"):
            # The owner's own dry run refused the target (or the list was empty): nothing to judge, nothing written.
            return "inconclusive", "write_not_prepared"
        return "failed", "write_path_broken"
    if path == "room_outside":
        return ("passed", "ok") if state == "OUTSIDE_SCOPE" and reply.startswith(ROOM_REFUSAL) else ("failed", "not_refused")
    if path == "room_leave_refused":
        return (("passed", "ok") if state == "DENIED" and reason == "scope_leave_request" and LEAVE_REFUSAL in reply
                else ("failed", "leave_not_refused"))
    return "failed", "unknown_path"


def room_tools(config=OPENCLAW_CONFIG):
    """The room agents allow their rooms' typed tools and keep every other tool closed (pulse-room.py room_tools): the
    two Pulse agents, which must exist, and every other typed room agent present (Amine 02/11, contact rooms brain)."""
    began = time.monotonic()
    try:
        spec = importlib.util.spec_from_file_location("pulse_room", HERE / "pulse-room.py")
        owner = importlib.util.module_from_spec(spec); spec.loader.exec_module(owner)
        entries = (json.loads(Path(config).read_text()).get("agents") or {}).get("entries") or {}
        names = sorted({*ROOM_AGENTS, *(name for name in entries if owner.typed_room_agent(name))})
        closed = all(isinstance(entries.get(name), dict) and isinstance(entries[name].get("tools"), dict)
                     and owner.room_tools(name, entries[name]["tools"]) == entries[name]["tools"] for name in names)
        state = ("passed", "ok") if closed else ("failed", "room_tools_not_closed")
    except (OSError, ValueError, SystemExit, AttributeError):
        state = ("failed", "room_tools_unverified")
    return {"path": "room_tools", "state": state[0], "reason": state[1], "seconds": round(time.monotonic() - began, 1)}


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
    if cause == TYPED_TECHNICAL_FAILURE:
        return "failed", "typed_technical_failure"
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
    if path == "write_recap" and (not re.search(r"Confirme", text) or "?" not in text or DONE_WRITE.search(text)):
        return "failed", "not_stopped_at_recap"
    return "passed", "ok"


def run_all(owner=None, room=room_turn, app=app_read, causes=None, tools=room_tools):
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
    rows.append(tools())
    for path, mode, action, params in ROOM_CALLS:
        row = room(mode, action, params)
        state, reason = room_verdict(path, row)
        rows.append({"path": path, "state": state, "reason": reason, "seconds": round(row["seconds"], 1)})
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
