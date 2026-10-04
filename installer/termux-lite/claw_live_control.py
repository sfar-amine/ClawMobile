"""Structured, payload-free projection of the existing claw-live Event stream."""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import json
import signal
import threading
import time

TITLES = {
    "CMD": "Exécution d’une action", "TOOL": "Lecture d’une capacité",
    "ACTION": "Action Samantha", "OK": "Action exécutée", "PASS": "Vérification réussie",
    "DONE": "Traitement terminé", "START": "Traitement démarré", "RUN": "Traitement en cours",
    "MODEL": "Appel du modèle", "IN": "Message reçu", "OUT": "Réponse envoyée",
    "ERROR": "Une action a échoué", "FAILED": "Une action a échoué", "FAIL": "Vérification échouée",
    "WARN": "Vérification nécessaire", "DEGRADED": "Fonctionnement dégradé",
    "RECOVERED": "Service récupéré", "RESOLVED": "Situation résolue",
    "RECOVER": "Récupération en cours", "VERIFY": "Vérification en cours",
    "PUBLISHED": "Publication terminée", "VERIFIED": "Vérification terminée",
    "PROMOTE": "Mémoire mise à jour", "CHECKPOINT": "Contexte enregistré",
    "COMPLETED_ACTION": "Action terminée", "OPEN_THREAD": "Demande enregistrée",
    "DECISION": "Décision enregistrée", "LEARNING": "Apprentissage enregistré",
    "CONSTRAINT": "Consigne enregistrée", "INFO": "Activité Samantha",
}
STATE = {
    "OK": "healthy", "PASS": "healthy", "DONE": "resolved", "COMPLETED_ACTION": "resolved",
    "FAILED": "failed", "FAIL": "failed", "ERROR": "failed", "DOWN": "failed",
    "WARN": "attention", "DEGRADED": "degraded", "HUMAN_REQUIRED": "waiting",
    "RECOVERED": "recovered", "RESOLVED": "resolved", "VERIFIED": "resolved",
    "START": "running", "RUN": "running", "CMD": "running", "RECOVER": "running",
    "MODEL": "running", "VERIFY": "running", "BLOCKED": "blocked",
}


def project(event, source_id, stamp=None):
    # Never expose event.detail/context/key/metric: these may contain commands,
    # message contents, contacts, headers, credentials or arbitrary raw payloads.
    tags = {str(t).upper() for t in event.tags}
    action = event.action.upper()
    if "LIVE" in tags:
        return None
    category = ("Mémoire" if tags & {"MEMORY", "DREAM"} else
                "Système immunitaire" if "IMMUNE" in tags else
                "Automatisation" if tags & {"CRON", "JOB"} else
                "Samantha" if tags & {"CHAT", "VOICE", "AGENT", "WHATSAPP"} else "Système")
    executor = "OpenAI" if "OPENAI" in tags else "Gemini" if tags & {"GOOGLE", "GEMINI"} else "Android" if "ADB" in tags else "Local" if tags & {"LOCAL", "TERMUX", "MEMORY", "IMMUNE", "SYSTEM", "BRIDGE"} else None
    at = stamp if stamp is not None else event.ts or time.time()
    if isinstance(at, str):
        try:
            at = datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            at = time.time()
    # Existing transcript created_at is milliseconds on older archives.
    if at > 1e12:
        at /= 1000
    status = STATE.get(action, "healthy" if action in TITLES else "unknown")
    return {"id": "activity-" + hashlib.sha256(source_id.encode()).hexdigest()[:24],
            "at": datetime.fromtimestamp(at, timezone.utc).isoformat(),
            "category": category, "title": TITLES.get(action, "Événement système"),
            "description": "Une vérification est nécessaire." if status in {"failed", "degraded", "attention"} else category,
            "status": status, "executor": executor,
            "provider": executor if executor in {"OpenAI", "Gemini"} else None,
            "source": "claw-live", "details": [{"label": "Source", "value": "claw-live"},
                {"label": "Catégorie", "value": category}, {"label": "Exécution", "value": executor}]}


class Collector:
    def __init__(self):
        self.rows = []
        self.source = "history"
        self.stamp = None
        self.sequence = 0

    def emit(self, event, dedupe_window=0):
        self.sequence += 1
        row = project(event, f"{self.source}:{self.sequence}", self.stamp)
        if row:
            self.rows.append(row)


def history(live, limit):
    limit = min(max(int(limit), 1), 100)
    collector = Collector()
    reader = live.OpenClawStream(collector, 0, 0)
    if not reader.connect():
        raise ValueError("activity_source_unavailable")
    try:
        rows = reader.conn.execute(
            "SELECT rowid,session_id,seq,event_json,created_at FROM transcript_events ORDER BY rowid DESC LIMIT ?",
            (min(limit * 3, 300),)).fetchall()
        for row in reversed(rows):
            collector.source = "transcript:" + str(row["rowid"])
            collector.sequence = 0
            collector.stamp = row["created_at"]
            reader.handle(row)
        return list(reversed(collector.rows[-limit:]))
    finally:
        reader.conn.close()


class PassiveSurface:
    """No ADB, screenshot, foreground inspection or surface-state writes."""
    def label(self):
        return "SYSTEM", ""


class JsonRenderer:
    def __init__(self, live):
        self.live = live
        self.sequence = 0
        self.session = str(time.time_ns())
        self.lock = threading.Lock()

    def emit(self, event, dedupe_window=0):
        with self.lock:
            self.sequence += 1
            row = project(event, self.session + ":" + str(self.sequence))
            if row:
                try:
                    print(json.dumps(row, ensure_ascii=False), flush=True)
                except (BrokenPipeError, OSError):
                    self.live.stop_event.set()


def stream(live):
    live.stop_event.clear()
    renderer = JsonRenderer(live); surfaces = PassiveSurface()
    signal.signal(signal.SIGTERM, lambda *_: live.stop_event.set())
    signal.signal(signal.SIGINT, lambda *_: live.stop_event.set())
    jobs = [live.DesktopStream(renderer, surfaces).loop,
            live.SlackBridgeStream(renderer, surfaces).loop,
            live.OpenClawStream(renderer, 0, 0).loop,
            live.ImprovementStream(renderer).loop,
            lambda: live.memory_loop(renderer),
            lambda: live.immune_source(renderer, live.HEALTH_LOG, "health"),
            lambda: live.immune_source(renderer, live.INCIDENT_LOG, "incident")]
    threads = [threading.Thread(target=f, daemon=True) for f in jobs]
    # Readiness is a transport event, never presented as a fabricated activity.
    # Serialize it before workers can emit their first event.
    print(json.dumps({"type": "ready", "schemaVersion": 1}), flush=True)
    for thread in threads:
        thread.start()
    try:
        while not live.stop_event.wait(0.5):
            pass
    finally:
        live.stop_event.set()
        deadline = time.monotonic() + 2
        for thread in threads:
            thread.join(max(0, deadline - time.monotonic()))
    return 0
