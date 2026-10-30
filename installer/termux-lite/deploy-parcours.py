#!/usr/bin/env python3
"""Deployment acceptance on five representative paths (Amine 29/10: at deploy time only, five paths, not every use case).

Runs after the runtime switch, against what really answers now: the Gateway with the synced plugin and the active
playbooks snapshot. Nothing is sent on WhatsApp and nothing is written:
  1. owner_read        owner brain (same agent as WhatsApp), dedicated session, an agenda read;
  2. contact_read      test contact « Recette Pulse » (fictitious number) in the Pulse room, a project list;
  3. incomplete_ask    same contact, an incomplete creation: Samantha must ask, never act;
  4. write_recap       owner brain, an agenda write that must stop at the confirmation recap, then cancelled;
  5. app_read          the Companion routes the app reads.
« Pulse est fermé » is a valid answer for 2 and 3. A provider outage is inconclusive (a rollback would not fix it).

Exit 0 = passed, 1 = a path failed (the caller rolls back), 3 = inconclusive (provider unavailable), 2 = usage.
One JSON object on stdout: the receipt section."""
import json, os, re, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPANION = "http://127.0.0.1:8765/v1"
OWNER_SESSION = "agent:main:recette-deploy"
ROOM_RUNNER = HERE / "deploy-parcours-room.cjs"
OWNER_TIMEOUT_S, ROOM_TIMEOUT_S = 150, 90
CLOSED = re.compile(r"Pulse est fermé")
# Sentences that only a broken path renders (core FAILURE_PHRASES / room fallbacks).
BROKEN = re.compile(r"n’a pas abouti|n'a pas abouti|pas confirmé|n’est pas établi|n'est pas établi|reste à vérifier|"
                    r"n’ai pas pu|n'ai pas pu|erreur interne|Rien n’a été exécuté\.$|"
                    # S24 30/10 dbe0f455: a refused typed tool call rendered as this (owner_read passed by mistake).
                    r"est momentanément indisponible")
# A provider outage: inconclusive, never a rollback.
OUTAGE = re.compile(r"modèle n’est pas joignable|modèle n'est pas joignable|interpretation_unavailable|"
                    r"rate.?limit|overloaded|429|503 Service", re.I)
DONE_WRITE = re.compile(r"\b(ajouté|créé|enregistré|c’est fait|c'est fait)\b", re.I)
PATHS = ("owner_read", "contact_read", "incomplete_ask", "write_recap", "app_read")


def owner_turn(text, run=subprocess.run):
    """One owner-brain turn through the Gateway, no delivery: (text, seconds, error)."""
    began = time.monotonic()
    try:
        p = run(["openclaw", "agent", "--agent", "main", "--session-key", OWNER_SESSION, "--message", text,
                 "--json", "--timeout", str(OWNER_TIMEOUT_S - 20)],
                capture_output=True, text=True, timeout=OWNER_TIMEOUT_S)
        value = json.loads(p.stdout or "{}")
        payloads = (value.get("result") or {}).get("payloads") or []
        reply = " ".join(str(x.get("text") or "") for x in payloads if isinstance(x, dict)).strip()
        error = None if value.get("status") == "ok" else str(value.get("error") or value.get("status") or p.returncode)[:200]
        return reply, time.monotonic() - began, error
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return "", time.monotonic() - began, type(e).__name__


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


def verdict(path, text, error):
    """'passed' | 'failed' | 'inconclusive' and a short reason (no user text in the receipt)."""
    if error and OUTAGE.search(str(error)) or OUTAGE.search(text):
        return "inconclusive", "provider_unavailable"
    if error:
        return "failed", "path_error"
    if not text.strip():
        return "failed", "empty_reply"
    if BROKEN.search(text):
        return "failed", "broken_reply"
    if path in ("contact_read", "incomplete_ask") and CLOSED.search(text):
        return "passed", "pulse_closed"
    if path == "incomplete_ask" and "?" not in text:
        return "failed", "no_question"
    if path == "write_recap" and (not re.search(r"Confirme", text) or "?" not in text or DONE_WRITE.search(text)):
        return "failed", "not_stopped_at_recap"
    return "passed", "ok"


def run_all(owner=owner_turn, room=room_turn, app=app_read):
    rows = []
    def record(path, text, took, error):
        state, reason = verdict(path, text, error)
        rows.append({"path": path, "state": state, "reason": reason, "seconds": round(took, 1)})
    record("owner_read", *owner("Qu'est-ce que j'ai dans mon agenda demain ?"))
    record("contact_read", *room("Liste mes projets Pulse"))
    record("incomplete_ask", *room("Crée un nouveau projet"))
    room("Annule la demande en cours")  # leaves no open question for the next run; not judged
    record("write_recap", *owner("Ajoute à mon agenda demain à 10h un rendez-vous intitulé Recette déploiement"))
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
