#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations

import argparse
import fcntl
import glob
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HOME = Path.home()
OPENCLAW = HOME / ".openclaw"
DC_LOG = OPENCLAW / "watchdogs" / "remote-desktop-process.log"
OC_DB = OPENCLAW / "agents" / "main" / "agent" / "openclaw-agent.sqlite"
PEOPLE_DB = OPENCLAW / "people" / "directory.db"
SURFACE_DIR = OPENCLAW / "observability"
SURFACE_FILE = SURFACE_DIR / "surfaces.json"
HEALTH_LOG = OPENCLAW / "health" / "health.log"
INCIDENT_LOG = OPENCLAW / "incidents" / "events.log"
ORCH_LOG = OPENCLAW / "incidents" / "orchestrator-worker.log"
REMOTE_LOG = OPENCLAW / "watchdogs" / "remote-desktop.log"
ADB_LOG = OPENCLAW / "watchdogs" / "adb-recovery.log"
SLACK_EVENT_LOG = OPENCLAW / "remote-bridge" / "slack" / "events.log"
REMOTE_REQUEST_DIR = OPENCLAW / "remote-bridge" / "requests"
AE_DIR = OPENCLAW / "autonomous-engineering"
IMPROVE_DB = OPENCLAW / "skill-intelligence" / "improvements.db"
MEMORY_DB = OPENCLAW / "context-sync" / "memory.db"
DREAM_ROOT = OPENCLAW / "workspace" / "memory" / "dreaming"
DREAM_DIARY = OPENCLAW / "workspace" / "DREAMS.md"
ADB_SERIAL = os.environ.get("SAMANTHA_ADB_SERIAL", "127.0.0.1:5556")

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
TAG_COLOR = {
    "CHAT": "\033[96m",
    "VOICE": "\033[94m",
    "WHATSAPP": "\033[92m",
    "IMMUNE": "\033[95m",
    "IMPROVE": "\033[38;5;141m",
    "TERMUX": "\033[93m",
    "AGENT": "\033[38;5;75m",
    "JOB": "\033[38;5;75m",
    "CRON": "\033[38;5;69m",
    "SYNC": "\033[38;5;45m",
    "MEMORY": "\033[38;5;110m",
    "BRIDGE": "\033[38;5;117m",
    "RDC": "\033[38;5;51m",
    "BOOTSTRAP": "\033[38;5;244m",
    "SLACK": "\033[38;5;201m",
    "ADB": "\033[38;5;214m",
    "LOCAL": "\033[38;5;118m",
    "OPENAI": "\033[38;5;141m",
    "SYSTEM": "\033[37m",
    "REPAIR": "\033[38;5;177m",
    "DREAM": "\033[38;5;213m",
    "SKILL": "\033[38;5;147m",
    "LIVE": "\033[90m",
}
ACTION_COLOR = {
    "OK": "\033[92m", "PASS": "\033[92m", "DONE": "\033[92m", "RUN": "\033[92m",
    "RECOVERED": "\033[92m", "SENT": "\033[92m", "OUT": "\033[92m",
    "PUBLISHED": "\033[92m", "VERIFIED": "\033[92m", "VALIDATED": "\033[92m",
    "FAILED": "\033[91m", "FAIL": "\033[91m", "ERROR": "\033[91m",
    "HUMAN_REQUIRED": "\033[91m", "REJECTED": "\033[91m",
    "WARN": "\033[38;5;214m", "DEGRADED": "\033[38;5;214m",
    "DOWN": "\033[91m", "LOSS": "\033[38;5;214m",
    "CMD": "\033[93m", "TOOL": "\033[93m", "ACTION": "\033[93m",
    "MODEL": "\033[38;5;141m", "DIAGNOSIS": "\033[38;5;141m",
    "RECOVER": "\033[94m", "RETRY": "\033[94m", "VERIFY": "\033[96m",
    "IN": "\033[96m", "INFO": "\033[96m", "START": "\033[96m", "IDLE": "\033[90m",
    "TRIGGER": "\033[38;5;214m", "PROMOTE": "\033[92m",
    "ROLLBACK": "\033[91m", "SHADOW": "\033[38;5;141m",
}
SENSITIVE_KEY = re.compile(r"(?i)(authorization|bearer|token|password|passwd|secret|api[_-]?key|cookie|credential|private[_-]?key)")
CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")
OTP_RE = re.compile(r"(?i)\b(otp|2fa|verification\s*code|security\s*code|code)\b\s*[:=\-]?\s*\d{4,8}\b")
KV_SECRET_RE = re.compile(r"(?i)((?:authorization|token|password|passwd|secret|api[_-]?key|cookie|credential)\s*[:=]\s*)([^\s,;}]+)")
PHONE_RE = re.compile(r"^\+\d{7,15}$")
lock = threading.Lock()
stop_event = threading.Event()
IDLE_NOTICE_AFTER_S = 30.0
IDLE_NOTICE_EVERY_S = 60.0
MAX_RENDER_DETAIL = 420
CLAW_LIVE_LOCK = OPENCLAW / "observability" / "claw-live.lock"
_instance_lock = None

@dataclass
class Event:
    tags: list[str]
    context: str = ""
    action: str = "INFO"
    detail: str = ""
    status: str = ""
    metric: str = ""
    key: str = ""
    ts: float | None = None

def ansi(text: str, code: str, enabled: bool, bold: bool = False) -> str:
    if not enabled:
        return text
    return f"{code}{BOLD if bold else ''}{text}{RESET}"

def scrub_text(value: Any) -> str:
    s = str(value or "")
    s = KV_SECRET_RE.sub(r"\1<redacted>", s)
    s = OTP_RE.sub(lambda m: m.group(1) + " <redacted>", s)
    s = CARD_RE.sub("<redacted>", s)
    s = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1<redacted>", s)
    return s

def command_backend_tags(command: str) -> list[str]:
    low = str(command or "").lower()
    tags: list[str] = []
    if "adb -s 127.0.0.1:5556" in low or ("adb " in low and "127.0.0.1:5556" in low):
        tags.append("ADB")
    if "claw-slack-" in low or "slack_bridge" in low or "slack-bridge" in low:
        tags.append("SLACK")
    return tags

def safe_obj(obj: Any, key: str = "") -> Any:
    if SENSITIVE_KEY.search(key):
        return "<redacted>"
    if isinstance(obj, dict):
        return {k: safe_obj(v, k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [safe_obj(v, key) for v in obj]
    if isinstance(obj, str):
        if key in {"content", "old_string", "new_string"}:
            return f"<omitted {len(obj)} chars>"
        if key == "command" and "context-event.sh" in obj:
            return obj.split("context-event.sh", 1)[0] + "context-event.sh <payload omitted>"
        return scrub_text(obj)
    return obj

def compact_json(obj: Any, limit: int = 900) -> str:
    text = json.dumps(safe_obj(obj), ensure_ascii=False, separators=(",", ":"))
    return text if len(text) <= limit else text[: limit - 1] + "…"

def preview(text: Any, limit: int) -> str:
    s = re.sub(r"\s+", " ", scrub_text(text)).strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"

def acquire_single_instance() -> bool:
    global _instance_lock
    CLAW_LIVE_LOCK.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = open(CLAW_LIVE_LOCK, "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.seek(0)
        pid = handle.read().strip() or "?"
        print(f"claw-live déjà actif (pid {pid}) dans un autre terminal. Ferme cette instance avant d'en lancer une seconde.", flush=True)
        handle.close()
        return False
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()))
    handle.flush()
    _instance_lock = handle
    return True

def _process_rows() -> list[tuple[int, str]]:
    try:
        proc = subprocess.run(
            ["ps", "-A", "-o", "pid=,args="],
            text=True,
            capture_output=True,
            timeout=2,
        )
    except Exception:
        return []
    rows: list[tuple[int, str]] = []
    for line in (proc.stdout or "").splitlines():
        match = re.match(r"\s*(\d+)\s+(.*)", line)
        if match:
            rows.append((int(match.group(1)), match.group(2)))
    return rows

def permanent_service_events(
    rows: list[tuple[int, str]] | None = None,
    current_root: str | None = None,
) -> list[Event]:
    rows = rows if rows is not None else _process_rows()
    if current_root is None:
        try:
            current_root = str((OPENCLAW / "releases" / "current" / "termux-lite").resolve())
        except Exception:
            current_root = ""
    groups = [
        ("OPENCLAW", [
            ("gateway", "openclaw-gateway", False),
            ("broker", "spawn-broker/worker.js", False),
        ]),
        ("BRIDGE", [
            ("companion", "dist/companion/server.js", False),
            ("slack", "claw-slack-bridge.mjs", True),
            ("rdc", "desktop-commander/dist/index.js remote", False),
        ]),
        ("IMMUNE", [
            ("root", "samantha-root-guardian.sh", True),
            ("tier0", "tier0/bin/tier0-watchdog.py", False),
            ("health", "samantha-health-manager.sh", True),
            ("incident", "incident-manager.sh", True),
            ("orchestrator", "incident-orchestrator-worker.sh", True),
            ("adb", "adb-recovery-watchdog.sh", True),
            ("rdc-watch", "remote-desktop-watchdog.sh", True),
        ]),
        ("LIVE", [
            ("claw-live", "/usr/bin/claw-live", False),
        ]),
    ]
    events: list[Event] = []
    for tag, specs in groups:
        parts: list[str] = []
        missing: list[str] = []
        stale: list[str] = []
        for label, pattern, must_be_current in specs:
            match = next(((pid, args) for pid, args in rows if pattern in args), None)
            if not match:
                missing.append(label)
                continue
            pid, args = match
            parts.append(f"{label}={pid}")
            if must_be_current and current_root and current_root not in args:
                stale.append(label)
        detail = " ".join(parts) or "aucun process"
        if missing:
            detail += " missing=" + ",".join(missing)
        if stale:
            detail += " stale=" + ",".join(stale)
        action = "RUN" if not missing and not stale else "WARN"
        status = "CURRENT" if tag == "IMMUNE" and not missing and not stale else ""
        events.append(Event(["SYSTEM", tag], "permanent", action, detail, status=status))
    return events

class Renderer:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.color = not args.no_color and sys.stdout.isatty()
        now = time.monotonic()
        self.last_emit = now
        self.last_activity = now
        self.last_heartbeat = 0.0
        self.counts: dict[str, int] = {}
        self.dedupe: dict[str, tuple[float, int]] = {}

    def allowed(self, event: Event) -> bool:
        if not self.args.only:
            return True
        requested = self.args.only.upper()
        return requested in {t.upper() for t in event.tags}

    def emit(self, event: Event, dedupe_window: float = 0) -> None:
        if not self.allowed(event):
            return
        if event.key and dedupe_window:
            now = time.monotonic()
            prior = self.dedupe.get(event.key)
            if prior and now - prior[0] < dedupe_window:
                self.dedupe[event.key] = (prior[0], prior[1] + 1)
                return
            if prior and prior[1] > 0:
                event.metric = (event.metric + " " if event.metric else "") + f"×{prior[1] + 1}"
            self.dedupe[event.key] = (now, 0)

        when = time.localtime(event.ts or time.time())
        stamp = time.strftime("%H:%M:%S", when)
        stamp_c = ansi(stamp, "\033[90m", self.color)
        tag_parts = []
        for tag in event.tags:
            color = TAG_COLOR.get(tag.upper(), "\033[37m")
            tag_parts.append(ansi(f"[{tag.upper()}]", color, self.color, bold=True))
            self.counts[tag.upper()] = self.counts.get(tag.upper(), 0) + 1
        context = f"[{event.context}]" if event.context else ""
        context_c = ansi(context, "\033[97m", self.color, bold=True) if context else ""
        ac = ACTION_COLOR.get(event.action.upper(), "\033[93m")
        action_c = ansi(event.action.upper(), ac, self.color, bold=True)
        detail = preview(event.detail, MAX_RENDER_DETAIL)
        detail_c = ansi(detail, "\033[97m", self.color)
        status_c = ""
        if event.status:
            sc = ACTION_COLOR.get(event.status.upper(), "\033[92m")
            status_c = ansi(event.status.upper(), sc, self.color, bold=True)
        metric_c = ansi(event.metric, "\033[90m", self.color) if event.metric else ""

        pieces = [stamp_c, "".join(tag_parts)]
        if context_c:
            pieces.append(context_c)
        pieces.append(action_c)
        if detail_c:
            pieces.append(detail_c)
        if status_c:
            pieces.append(ansi("→", "\033[90m", self.color))
            pieces.append(status_c)
        if metric_c:
            pieces.append(metric_c)
        line = " ".join(p for p in pieces if p)
        with lock:
            print(line, flush=True)
        now = time.monotonic()
        self.last_emit = now
        if "LIVE" not in {tag.upper() for tag in event.tags}:
            self.last_activity = now

    def heartbeat(self) -> None:
        while not stop_event.wait(5):
            now = time.monotonic()
            idle = int(now - self.last_activity)
            if idle < IDLE_NOTICE_AFTER_S:
                continue
            if self.last_heartbeat and now - self.last_heartbeat < IDLE_NOTICE_EVERY_S:
                continue
            counts = " ".join(f"{k}:{v}" for k, v in sorted(self.counts.items()) if v)
            event = Event(["LIVE"], action="IDLE", detail=f"écoute active · {counts or 'aucun événement'} · idle {idle}s")
            self.emit(event)
            self.last_heartbeat = now

class SurfaceRegistry:
    def __init__(self, renderer: Renderer):
        self.renderer = renderer
        self.state = {
            "mode": "text",
            "title": "",
            "conversation_id": "",
            "last_seen": "",
            "last_seen_epoch": 0,
            "voice_started": "",
        }
        self._load()

    def _load(self) -> None:
        try:
            obj = json.loads(SURFACE_FILE.read_text())
            if isinstance(obj, dict):
                self.state.update({k: obj.get(k, self.state[k]) for k in self.state})
        except Exception:
            pass

    def _save(self) -> None:
        try:
            SURFACE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
            tmp = SURFACE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2) + "\n")
            os.chmod(tmp, 0o600)
            tmp.replace(SURFACE_FILE)
        except Exception:
            pass

    def label(self) -> tuple[str, str]:
        mode = self.state.get("mode") or "text"
        title = self.state.get("title") or ""
        fresh = time.time() - float(self.state.get("last_seen_epoch") or 0) < 14400
        visible_title = title if fresh else ""
        if mode == "voice":
            fallback = self.state.get("voice_started") or time.strftime("%H:%M")
            return "VOICE", visible_title or f"session {fallback}"
        return "CHAT", visible_title or "ChatGPT"

    def _run_adb(self, args: list[str], timeout: float = 4) -> str:
        try:
            p = subprocess.run(["adb", "-s", ADB_SERIAL, "shell", *args], text=True, capture_output=True, timeout=timeout)
            return (p.stdout or "") + (p.stderr or "")
        except Exception:
            return ""

    def _voice_active(self) -> bool:
        text = self._run_adb(["appops", "get", "com.openai.chatgpt", "RECORD_AUDIO"], timeout=3)
        return bool(re.search(r"RECORD_AUDIO:[^\n]*\(running\)", text, re.I))

    def _focus(self) -> str:
        raw = self._run_adb(["dumpsys", "window"], timeout=4)
        for line in raw.splitlines():
            if "mCurrentFocus=" in line:
                return line.strip()
        return ""

    def _capture_title(self) -> str:
        try:
            subprocess.run(["adb", "-s", ADB_SERIAL, "shell", "uiautomator", "dump", "/sdcard/claw-live-chat.xml"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=6)
            proc = subprocess.run(["adb", "-s", ADB_SERIAL, "shell", "cat", "/sdcard/claw-live-chat.xml"],
                                  text=True, capture_output=True, timeout=4)
            xml = proc.stdout
        except Exception:
            return ""
        candidates: list[tuple[int, str]] = []
        rejects = {
            "chatgpt", "new chat", "message chatgpt", "share", "back", "voice",
            "projects", "search", "settings", "plugins", "close", "more",
        }
        for node in re.findall(r"<node\b[^>]*>", xml):
            text_m = re.search(r'text="([^"]*)"', node)
            bounds_m = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
            if not text_m or not bounds_m:
                continue
            text = text_m.group(1).strip()
            if not text or text.casefold() in rejects or len(text) > 120:
                continue
            y1 = int(bounds_m.group(2))
            y2 = int(bounds_m.group(4))
            if y1 > 650:
                continue
            if re.fullmatch(r"[\d\s:%.+-]+", text):
                continue
            score = 0
            if y1 < 400:
                score += 3
            if 3 <= len(text) <= 80:
                score += 2
            if " " in text:
                score += 1
            candidates.append((score * 1000 - y2, text))
        return max(candidates)[1] if candidates else ""

    def _capture_conversation_id(self, focus: str) -> str:
        ids = re.findall(r"https://chatgpt\.com/c/([A-Za-z0-9_-]{8,200})", focus)
        return ids[-1] if ids else ""

    def loop(self) -> None:
        prior_voice = None
        prior_foreground = False
        while not stop_event.wait(2):
            voice = self._voice_active()
            if voice != prior_voice:
                if voice:
                    self.state["mode"] = "voice"
                    self.state["voice_started"] = time.strftime("%H:%M")
                    tag, ctx = self.label()
                    self.renderer.emit(Event([tag], ctx, "START", "ChatGPT Voice actif"))
                elif prior_voice:
                    tag, ctx = self.label()
                    self.renderer.emit(Event([tag], ctx, "LOSS", "ChatGPT Voice inactif"))
                    self.state["mode"] = "text"
                prior_voice = voice
                self._save()

            focus = self._focus()
            foreground = "com.openai.chatgpt/com.openai.chatgpt" in focus and "mCurrentFocus" in focus
            if foreground and not prior_foreground:
                cid = self._capture_conversation_id(focus)
                title = self._capture_title()
                changed = False
                if cid:
                    self.state["conversation_id"] = cid
                    changed = True
                if title:
                    self.state["title"] = title
                    changed = True
                if not voice:
                    self.state["mode"] = "text"
                if changed:
                    self.state["last_seen"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                    self.state["last_seen_epoch"] = time.time()
                    self._save()
                    tag, ctx = self.label()
                    self.renderer.emit(Event([tag], ctx, "INFO", "surface ChatGPT identifiée"))
            prior_foreground = foreground

class PeopleResolver:
    def __init__(self):
        self.cache: dict[str, str] = {}
        self.last = 0.0
    def refresh(self) -> None:
        if time.monotonic() - self.last < 60:
            return
        self.last = time.monotonic()
        if not PEOPLE_DB.exists():
            return
        try:
            conn = sqlite3.connect(f"file:{PEOPLE_DB}?mode=ro", uri=True, timeout=2)
            rows = conn.execute(
                "SELECT ph.e164,p.display_name FROM phones ph JOIN people p ON p.person_id=ph.person_id "
                "WHERE ph.e164 IS NOT NULL AND p.active=1"
            ).fetchall()
            conn.close()
            self.cache = {str(e): str(n) for e, n in rows if e and n}
        except Exception:
            pass

    def name(self, peer: str, label: str = "") -> str:
        self.refresh()
        return self.cache.get(peer) or label or peer or "WhatsApp"

def extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    texts: list[str] = []
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "thinking":
                continue
            value = item.get("text")
            if isinstance(value, str):
                texts.append(value)
    return "\n".join(texts)

def tail_lines(path: Path):
    if not path.exists():
        return
    proc = subprocess.Popen(["tail", "-n", "0", "-F", str(path)], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if stop_event.is_set():
                break
            yield line.rstrip("\n")
    finally:
        proc.terminate()

def parse_kv(line: str) -> tuple[str, list[tuple[str, str]]]:
    parts = line.split()
    ts = parts[0] if parts else ""
    pairs: list[tuple[str, str]] = []
    for match in re.finditer(r"([A-Za-z0-9_.-]+)=([^\s]+)", line):
        pairs.append((match.group(1), match.group(2).strip('"')))
    return ts, pairs

def kv_last(pairs: list[tuple[str, str]], key: str, default: str = "") -> str:
    vals = [value for k, value in pairs if k == key]
    return vals[-1] if vals else default
def immune_source(renderer: Renderer, path: Path, kind: str) -> None:
    for line in tail_lines(path) or []:
        if not line:
            continue
        low = line.lower()
        if kind == "health":
            _, pairs = parse_kv(line)
            service = kv_last(pairs, "service") or kv_last(pairs, "component") or "health"
            state = kv_last(pairs, "state", "info").upper()
            action = kv_last(pairs, "action")
            detail = action or "health state change"
            renderer.emit(
                Event(["IMMUNE"], service, state, detail, key=f"health:{service}:{state}:{detail}"),
                dedupe_window=30,
            )
        elif kind == "incident":
            _, pairs = parse_kv(line)
            iid = kv_last(pairs, "id")
            state = kv_last(pairs, "state") or kv_last(pairs, "kind") or "info"
            channel = kv_last(pairs, "channel")
            detail = " ".join(x for x in [kv_last(pairs, "event"), channel] if x)
            renderer.emit(
                Event(["IMMUNE"], f"incident {iid[:8]}" if iid else "incident", state.upper(), detail,
                      key=f"incident:{iid}:{state}:{detail}"),
                dedupe_window=5,
            )
        elif kind == "orch":
            _, pairs = parse_kv(line)
            iid = kv_last(pairs, "incident")
            comps = [value for key, value in pairs if key == "component"]
            target = comps[-1] if comps else "orchestrator"
            terminal = kv_last(pairs, "terminal")
            action = terminal or kv_last(pairs, "action") or kv_last(pairs, "transition") or "INFO"
            detail = " ".join(
                x for x in [kv_last(pairs, "diagnosis"), kv_last(pairs, "result"), kv_last(pairs, "reason")] if x
            )
            renderer.emit(Event(["IMMUNE"], f"{target} · {iid[:8]}" if iid else target, action.upper(), detail))
        elif kind == "bridge":
            action = "INFO"
            if "self-heal success" in low or "recovered" in low:
                action = "RECOVERED"
            elif "failed" in low or "down" in low:
                action = "FAILED"
            elif "restart" in low:
                action = "RECOVER"
            renderer.emit(
                Event(["BRIDGE"], "Desktop Commander", action, preview(line, 240),
                      key=f"bridge:{preview(line, 120)}"),
                dedupe_window=10,
            )
        elif kind == "adb":
            action = "RECOVER" if "attempt" in low or "recover" in low else "INFO"
            if "success" in low or "ready" in low:
                action = "RECOVERED"
            if "fail" in low or "human" in low:
                action = "FAILED"
            renderer.emit(
                Event(["IMMUNE"], "adb", action, preview(line, 260), key=f"adb:{preview(line, 120)}"),
                dedupe_window=10,
            )

class DesktopStream:
    def __init__(self, renderer: Renderer, surfaces: SurfaceRegistry):
        self.r = renderer
        self.surfaces = surfaces

    def loop(self) -> None:
        for raw in tail_lines(DC_LOG) or []:
            if "Received tool call " in raw and " metadata:" in raw:
                body = raw.split("Received tool call ", 1)[1].split(" metadata:", 1)[0]
                try:
                    _, call = body.split(": ", 1)
                    tool, payload = call.split(" ", 1)
                    args = safe_obj(json.loads(payload))
                except Exception:
                    continue
                surface, ctx = self.surfaces.label()
                self._tool(surface, ctx, tool, args)
            elif raw.startswith("✅ Tool call ") and " completed" in raw:
                match = re.match(r"✅ Tool call ([A-Za-z0-9_]+) completed", raw)
                if match:
                    surface, ctx = self.surfaces.label()
                    self.r.emit(Event(["TERMUX", surface, "RDC"], ctx, "OK", f"{match.group(1)} completed"))

    def _tool(self, surface: str, ctx: str, tool: str, args: Any) -> None:
        if not isinstance(args, dict):
            args = {}
        markers = ("SOUL.md", "AGENTS.md", "OPERATING_RULES.md", "CAPABILITIES.md", "HYBRID_CONTEXT.md")
        bootstrap = any(marker in compact_json(args, 4000) for marker in markers)
        base_tags = ["TERMUX", surface, "RDC"] + (["BOOTSTRAP"] if bootstrap else [])
        if tool == "start_process":
            cmd = scrub_text(args.get("command", ""))
            tags = base_tags + command_backend_tags(cmd)
            metric = f"timeout={args.get('timeout_ms')}ms" if args.get("timeout_ms") else ""
            self.r.emit(Event(tags, ctx, "CMD", "$ " + cmd, metric=metric))
        elif tool in {"read_file", "read_multiple_files"}:
            detail = args.get("path") or compact_json(args, 500)
            self.r.emit(Event(base_tags, ctx, "TOOL", f"{tool} {detail}"))
        elif tool in {"write_file", "edit_block", "create_directory", "move_file"}:
            detail = args.get("path") or args.get("file_path") or compact_json(args, 500)
            self.r.emit(Event(base_tags, ctx, "ACTION", f"{tool} {detail}"))
        else:
            self.r.emit(Event(base_tags, ctx, "TOOL", f"{tool} {compact_json(args, 700)}"))

class OpenClawStream:
    def __init__(self, renderer: Renderer, preview_chars: int, history: int = 0):
        self.r = renderer
        self.preview_chars = preview_chars
        self.history = max(0, int(history))
        self.people = PeopleResolver()
        self.conn: sqlite3.Connection | None = None
        self.rowid = 0
        self.session_cache: dict[str, dict[str, str]] = {}

    def connect(self) -> bool:
        if not OC_DB.exists():
            return False
        try:
            self.conn = sqlite3.connect(
                f"file:{OC_DB}?mode=ro", uri=True, timeout=3, check_same_thread=False
            )
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA busy_timeout=3000")
            max_rowid = int(
                self.conn.execute("SELECT COALESCE(MAX(rowid),0) FROM transcript_events").fetchone()[0]
            )
            self.rowid = max(0, max_rowid - self.history)
            return True
        except Exception:
            self.conn = None
            return False

    def metadata(self, session_id: str) -> dict[str, str]:
        cached = self.session_cache.get(session_id)
        if cached:
            return cached
        out = {"session_key": "", "display": "", "channel": "", "kind": "", "peer": "", "label": ""}
        if not self.conn:
            return out
        try:
            row = self.conn.execute(
                "SELECT session_key,COALESCE(display_name,''),COALESCE(label,'') "
                "FROM session_nodes WHERE current_session_id=? LIMIT 1", (session_id,)
            ).fetchone()
            if row:
                out["session_key"], out["display"], node_label = map(str, row)
                if not out["display"]:
                    out["display"] = node_label
            conv = self.conn.execute(
                "SELECT c.channel,c.kind,c.peer_id,COALESCE(c.label,'') "
                "FROM session_conversations sc JOIN conversations c ON c.conversation_id=sc.conversation_id "
                "WHERE sc.session_id=? ORDER BY sc.last_seen_at DESC LIMIT 1", (session_id,)
            ).fetchone()
            if conv:
                out["channel"], out["kind"], out["peer"], out["label"] = map(str, conv)
        except Exception:
            pass
        if out["session_key"] or out["channel"]:
            self.session_cache[session_id] = out
        return out
    def classify(self, meta: dict[str, str]) -> tuple[str, str]:
        key = meta.get("session_key", "")
        if meta.get("channel") == "whatsapp":
            ctx = self.people.name(meta.get("peer", ""), meta.get("label", ""))
            return "WHATSAPP", ctx
        if ":job:" in key:
            raw = key.split(":job:", 1)[1]
            name = raw.rsplit(":", 1)[0] if ":" in raw else raw
            return "JOB", meta.get("display") or name
        if ":cron:" in key:
            return "CRON", meta.get("display") or key.split(":cron:", 1)[1][:18]
        if "autonomous-engineering" in key:
            return "IMPROVE", meta.get("display") or "Autonomous Engineering"
        return "AGENT", meta.get("display") or (
            key.split("agent:main:", 1)[-1] if key else "OpenClaw"
        )

    def emit_tool(self, source: str, ctx: str, block: dict[str, Any]) -> None:
        name = str(block.get("name") or "tool")
        args = safe_obj(block.get("arguments") or {})
        local_tool = name in {"exec", "read", "edit", "process", "ls", "write"}
        tags = ["TERMUX", source, "LOCAL"] if local_tool else [source, "LOCAL"]
        if name == "exec" and isinstance(args, dict):
            cmd = scrub_text(args.get("command", ""))
            tags += command_backend_tags(cmd)
            metric = f"timeout={args.get('timeoutSeconds')}s" if args.get("timeoutSeconds") else ""
            self.r.emit(Event(tags, ctx, "CMD", "$ " + cmd, metric=metric))
        elif name in {"read", "edit", "ls", "write", "process"}:
            self.r.emit(Event(tags, ctx, "TOOL", f"{name} {compact_json(args, 700)}"))
        else:
            self.r.emit(Event(tags, ctx, "TOOL", f"{name} {compact_json(args, 700)}"))

    def handle(self, row: sqlite3.Row) -> None:
        sid = str(row["session_id"])
        try:
            obj = json.loads(row["event_json"] or "{}")
        except Exception:
            return
        msg = obj.get("message")
        if not isinstance(msg, dict):
            return
        role = msg.get("role")
        meta = self.metadata(sid)
        source, ctx = self.classify(meta)
        content = msg.get("content")
        if role == "user":
            text = extract_text(content)
            if source == "WHATSAPP" and text:
                self.r.emit(Event([source], ctx, "IN", f'"{preview(text, self.preview_chars)}"'))
            elif source in {"JOB", "CRON"} and text:
                self.r.emit(Event([source], ctx, "START", preview(text, self.preview_chars)))
            return
        if role == "assistant":
            provider = msg.get("provider")
            model = msg.get("model")
            if provider or model:
                model_name = "/".join(str(x) for x in (provider, model) if x)
                provider_tag = "OPENAI" if str(provider).lower() == "openai" else "LOCAL" if str(provider).lower().startswith("openclaw") else str(provider).upper()
                self.r.emit(Event([source, provider_tag], ctx, "MODEL", model_name))
            blocks = content if isinstance(content, list) else []
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    self.emit_tool(source, ctx, block)
            text = extract_text(content)
            if text:
                action = "OUT" if source == "WHATSAPP" else "DONE" if source in {"JOB", "CRON"} else "INFO"
                detail = f'"{preview(text, self.preview_chars)}"' if source == "WHATSAPP" else preview(text, self.preview_chars)
                self.r.emit(Event([source], ctx, action, detail))
            return
        if role == "toolResult":
            name = str(msg.get("toolName") or "tool")
            error = bool(msg.get("isError"))
            text = extract_text(content)
            detail = name
            if text:
                detail += " " + preview(text, min(self.preview_chars, 220))
            self.r.emit(Event(["TERMUX", source, "LOCAL"], ctx, "ERROR" if error else "OK", detail))

    def loop(self) -> None:
        if not self.connect():
            self.r.emit(Event(["SYSTEM"], "OpenClaw", "WARN", f"SQLite indisponible: {OC_DB}"))
            return
        assert self.conn is not None
        while not stop_event.wait(0.6):
            try:
                rows = self.conn.execute(
                    "SELECT rowid,session_id,seq,event_json,created_at FROM transcript_events "
                    "WHERE rowid>? ORDER BY rowid LIMIT 300", (self.rowid,)
                ).fetchall()
                for row in rows:
                    self.rowid = max(self.rowid, int(row["rowid"]))
                    self.handle(row)
            except sqlite3.Error:
                time.sleep(1)
class SlackBridgeStream:
    def __init__(self, renderer: Renderer, surfaces: SurfaceRegistry):
        self.r = renderer
        self.surfaces = surfaces
        self.request_mtime: dict[str, float] = {}

    def _request_snapshot(self) -> dict[str, float]:
        if not REMOTE_REQUEST_DIR.exists():
            return {}
        return {
            str(path): path.stat().st_mtime
            for path in REMOTE_REQUEST_DIR.glob("*.json")
            if path.is_file()
        }

    def _emit_request_file(self, path: str) -> None:
        try:
            with open(path) as handle:
                obj = json.load(handle)
        except Exception:
            return
        surface, ctx = self.surfaces.label()
        method = str(obj.get("method") or "")
        state = str(obj.get("state") or "")
        request_id = str(obj.get("requestId") or "")
        result = obj.get("result") if isinstance(obj.get("result"), dict) else {}
        metric_parts = []
        if obj.get("completedAt") and obj.get("startedAt"):
            metric_parts.append(f"{int(obj['completedAt']) - int(obj['startedAt'])}ms")
        if request_id:
            metric_parts.append(f"request={request_id[:18]}")
        metric = " ".join(metric_parts)
        if method in {"exec_wait", "process_start"}:
            cmd = scrub_text(result.get("command") or "")
            tags = ["TERMUX", surface, "SLACK"] + command_backend_tags(cmd)
            if cmd:
                self.r.emit(Event(tags, ctx, "CMD", "$ " + cmd, metric=metric))
            self.r.emit(Event(["BRIDGE", "SLACK"], ctx, "OK" if state == "completed" else state.upper() or "INFO", method, metric=metric))
        else:
            self.r.emit(Event(["BRIDGE", "SLACK"], ctx, "OK" if state == "completed" else state.upper() or "INFO", method, metric=metric))

    def _receipt_fallback_loop(self) -> None:
        request_mtime = self._request_snapshot()
        pending: dict[str, tuple[float, float]] = {}
        try:
            dir_stamp = REMOTE_REQUEST_DIR.stat().st_mtime_ns
        except OSError:
            dir_stamp = 0
        while not stop_event.wait(0.5):
            now = time.monotonic()
            try:
                current_dir_stamp = REMOTE_REQUEST_DIR.stat().st_mtime_ns
            except OSError:
                current_dir_stamp = 0

            if current_dir_stamp != dir_stamp:
                current = self._request_snapshot()
                for path, mtime in current.items():
                    if mtime > request_mtime.get(path, 0):
                        pending[path] = (mtime, now)
                request_mtime = current
                dir_stamp = current_dir_stamp

            try:
                audit_mtime = SLACK_EVENT_LOG.stat().st_mtime
            except OSError:
                audit_mtime = 0.0

            for path, (mtime, first_seen) in list(pending.items()):
                if now - first_seen < 1.2:
                    continue
                if mtime > audit_mtime + 0.5:
                    self._emit_request_file(path)
                pending.pop(path, None)

    def loop(self) -> None:
        if not SLACK_EVENT_LOG.exists():
            self._receipt_fallback_loop()
            return
        threading.Thread(
            target=self._receipt_fallback_loop,
            daemon=True,
            name="slack-receipt-fallback",
        ).start()
        for raw in tail_lines(SLACK_EVENT_LOG) or []:
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            event_name = str(obj.get("event") or "")
            method = str(obj.get("method") or "")
            request_id = str(obj.get("requestId") or "")
            summary = obj.get("summary") if isinstance(obj.get("summary"), dict) else {}
            surface, ctx = self.surfaces.label()
            metric = f"request={request_id[:18]}" if request_id else ""

            if event_name == "request":
                if method in {"exec_wait", "process_start"}:
                    cmd = scrub_text(summary.get("command", ""))
                    tags = ["TERMUX", surface, "SLACK"] + command_backend_tags(cmd)
                    self.r.emit(Event(tags, ctx, "CMD", "$ " + cmd, metric=metric))
                elif method in {"read_file", "write_file", "process_status", "process_input", "process_stop", "artifact_read"}:
                    detail = summary.get("path") or summary.get("processId") or summary.get("artifactId") or ""
                    action = "ACTION" if method in {"write_file", "process_input", "process_stop"} else "TOOL"
                    self.r.emit(Event(["TERMUX", surface, "SLACK"], ctx, action, f"{method} {detail}".strip(), metric=metric))
                else:
                    self.r.emit(Event(["BRIDGE", "SLACK"], ctx, "ACTION", method or "request", metric=metric))
                continue

            state = str(obj.get("state") or "")
            if event_name == "result":
                status = "OK" if state in {"completed", "accepted", "ready"} else state.upper() or "OK"
                self.r.emit(Event(["BRIDGE", "SLACK"], ctx, status, method, metric=metric))
            elif event_name in {"error", "rejected"}:
                detail = scrub_text(obj.get("error") or state or method)
                self.r.emit(Event(["BRIDGE", "SLACK"], ctx, "ERROR", detail, metric=metric))

class ImprovementStream:
    def __init__(self, renderer: Renderer):
        self.r = renderer
        self.shadow_mtime: dict[str, float] = {}
        self.delivery_mtime: dict[str, float] = {}
        self.dream_mtime: dict[str, float] = {}
        self.improve_seq = 0

    def _snapshot(self, pattern: str) -> dict[str, float]:
        return {path: os.path.getmtime(path) for path in glob.glob(pattern) if os.path.isfile(path)}

    def start(self) -> None:
        self.shadow_mtime = self._snapshot(str(AE_DIR / "shadow" / "*.json"))
        self.delivery_mtime = self._snapshot(str(AE_DIR / "deliveries" / "*.json"))
        dream_files = glob.glob(str(DREAM_ROOT / "*" / "*.md"))
        if DREAM_DIARY.exists():
            dream_files.append(str(DREAM_DIARY))
        self.dream_mtime = {path: os.path.getmtime(path) for path in dream_files}
        if IMPROVE_DB.exists():
            try:
                conn = sqlite3.connect(f"file:{IMPROVE_DB}?mode=ro", uri=True)
                self.improve_seq = int(
                    conn.execute("SELECT COALESCE(MAX(seq),0) FROM improvement_history").fetchone()[0]
                )
                conn.close()
            except Exception:
                pass

    def _shadow(self, path: str) -> None:
        try:
            with open(path) as handle:
                obj = json.load(handle)
        except Exception:
            return
        iid = str(obj.get("incident_id") or Path(path).stem)
        model = obj.get("actual_model") or obj.get("model")
        attempts = obj.get("attempts") or []
        metric = ""
        if attempts and isinstance(attempts[-1], dict) and attempts[-1].get("duration_ms") is not None:
            metric = f"{attempts[-1]['duration_ms']}ms"
        if model:
            self.r.emit(Event(["IMPROVE", "REPAIR"], iid[:8], "MODEL", str(model), metric=metric))
        diagnosis = obj.get("diagnosis") or {}
        if isinstance(diagnosis, dict):
            root = diagnosis.get("root_cause")
            if root:
                self.r.emit(Event(["IMPROVE", "REPAIR"], iid[:8], "DIAGNOSIS", preview(root, 260)))
            proposed = diagnosis.get("proposed_action")
            if proposed:
                self.r.emit(Event(["IMPROVE", "REPAIR"], iid[:8], "ACTION", preview(proposed, 260)))
        decision = obj.get("repair_decision") or {}
        if isinstance(decision, dict) and decision:
            detail = " ".join(
                str(decision.get(key)) for key in ("action_id", "disposition", "reason") if decision.get(key)
            )
            status = "OK" if obj.get("status") == "success" else str(obj.get("status") or "").upper()
            self.r.emit(Event(["IMPROVE", "REPAIR"], iid[:8], "VERIFY", preview(detail, 260), status=status))

    def _delivery(self, path: str) -> None:
        try:
            with open(path) as handle:
                obj = json.load(handle)
        except Exception:
            return
        repo = obj.get("repository") or Path(str(obj.get("repo") or "")).name or "delivery"
        state = str(obj.get("state") or "update")
        commit = str(obj.get("remote_commit") or obj.get("head") or "")[:12]
        reason = preview(obj.get("reason") or "", 180)
        detail = " ".join(x for x in [commit, reason] if x)
        self.r.emit(
            Event(
                ["SYNC"],
                str(repo),
                state.upper(),
                detail,
                status="VERIFIED" if obj.get("verified_at") else "",
            )
        )

    def _improvement_history(self) -> None:
        if not IMPROVE_DB.exists():
            return
        try:
            conn = sqlite3.connect(f"file:{IMPROVE_DB}?mode=ro", uri=True, timeout=2)
            rows = conn.execute(
                "SELECT seq,candidate_id,action,payload,created_at FROM improvement_history "
                "WHERE seq>? ORDER BY seq LIMIT 100",
                (self.improve_seq,),
            ).fetchall()
            conn.close()
        except Exception:
            return
        for seq, cid, action, payload, _created in rows:
            self.improve_seq = max(self.improve_seq, int(seq))
            try:
                pobj = json.loads(payload or "{}")
                detail = preview(compact_json(pobj, 360), 360)
            except Exception:
                detail = preview(payload, 360)
            act = str(action or "INFO").upper()
            if "VALID" in act:
                act = "VALIDATED"
            elif "PROMOT" in act or "APPLY" in act:
                act = "PROMOTE"
            elif "REJECT" in act:
                act = "REJECTED"
            elif "SHADOW" in act:
                act = "SHADOW"
            self.r.emit(Event(["IMPROVE", "SKILL"], str(cid)[:8], act, detail))

    def loop(self) -> None:
        self.start()
        while not stop_event.wait(1):
            current = self._snapshot(str(AE_DIR / "shadow" / "*.json"))
            for path, mtime in current.items():
                if mtime > self.shadow_mtime.get(path, 0):
                    self._shadow(path)
            self.shadow_mtime = current

            current = self._snapshot(str(AE_DIR / "deliveries" / "*.json"))
            for path, mtime in current.items():
                if mtime > self.delivery_mtime.get(path, 0):
                    self._delivery(path)
            self.delivery_mtime = current

            dream_files = glob.glob(str(DREAM_ROOT / "*" / "*.md"))
            if DREAM_DIARY.exists():
                dream_files.append(str(DREAM_DIARY))
            current_dream = {path: os.path.getmtime(path) for path in dream_files}
            for path, mtime in current_dream.items():
                if mtime > self.dream_mtime.get(path, 0):
                    phase = Path(path).parent.name if path != str(DREAM_DIARY) else "diary"
                    self.r.emit(Event(["IMPROVE", "DREAM"], phase, "DONE", Path(path).name))
            self.dream_mtime = current_dream
            self._improvement_history()
def memory_loop(renderer: Renderer) -> None:
    if not MEMORY_DB.exists():
        return
    try:
        conn = sqlite3.connect(f"file:{MEMORY_DB}?mode=ro", uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        rev = int(conn.execute("SELECT COALESCE(MAX(revision),0) FROM events").fetchone()[0])
    except Exception:
        return
    while not stop_event.wait(1):
        try:
            rows = conn.execute(
                "SELECT revision,surface,kind,text FROM events WHERE revision>? ORDER BY revision LIMIT 100",
                (rev,),
            ).fetchall()
            for row in rows:
                rev = max(rev, int(row["revision"]))
                renderer.emit(
                    Event(
                        ["MEMORY"],
                        str(row["surface"]),
                        str(row["kind"]).upper(),
                        preview(row["text"], 220),
                        metric=f"rev={row['revision']}",
                    )
                )
        except Exception:
            time.sleep(1)

def raw_mode() -> int:
    procs: list[subprocess.Popen] = []
    try:
        if DC_LOG.exists():
            procs.append(subprocess.Popen(["tail", "-n", "0", "-F", str(DC_LOG)]))
        logs = glob.glob("/data/data/com.termux/files/usr/tmp/openclaw/openclaw-*.log")
        if logs:
            procs.append(subprocess.Popen(["tail", "-n", "0", "-F", max(logs, key=os.path.getmtime)]))
        while procs:
            time.sleep(1)
            procs = [proc for proc in procs if proc.poll() is None]
    except KeyboardInterrupt:
        pass
    finally:
        for proc in procs:
            proc.terminate()
    return 0

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Semantic live observability for Claw on Termux.")
    parser.add_argument("--compact", action="store_true", help="Reduce message previews and tool details.")
    parser.add_argument("--raw", action="store_true", help="Tail raw Desktop Commander and OpenClaw logs.")
    parser.add_argument("--allow-multiple", action="store_true", help="Allow an additional semantic claw-live instance intentionally.")
    parser.add_argument(
        "--only",
        choices=[
            "immune", "improve", "whatsapp", "chat", "voice", "termux",
            "agent", "job", "cron", "sync", "memory", "bridge", "system",
            "rdc", "slack", "adb", "local", "openai",
        ],
    )
    parser.add_argument("--preview-chars", type=int, default=160)
    parser.add_argument("--history", type=int, default=0, help="Replay up to N recent OpenClaw transcript rows before following live.")
    parser.add_argument("--no-color", action="store_true")
    return parser.parse_args()

def main() -> int:
    args = parse_args()
    if args.raw:
        return raw_mode()
    if not args.allow_multiple and not acquire_single_instance():
        return 2
    if args.compact:
        args.preview_chars = min(args.preview_chars, 80)
    renderer = Renderer(args)
    surfaces = SurfaceRegistry(renderer)
    print("Claw Live v2 — Ctrl+C pour quitter", flush=True)
    if renderer.color:
        legend = " ".join(
            ansi(f"[{tag}]", TAG_COLOR[tag], True, bold=True)
            for tag in ("CHAT", "VOICE", "WHATSAPP", "IMMUNE", "IMPROVE", "TERMUX", "RDC", "SLACK", "ADB", "LOCAL", "OPENAI")
        )
        print(legend, flush=True)
    else:
        print("[CHAT] [VOICE] [WHATSAPP] [IMMUNE] [IMPROVE] [TERMUX] [RDC] [SLACK] [ADB] [LOCAL] [OPENAI]", flush=True)
    for event in permanent_service_events():
        renderer.emit(event)

    threads = [
        threading.Thread(target=renderer.heartbeat, daemon=True, name="heartbeat"),
        threading.Thread(target=surfaces.loop, daemon=True, name="surface"),
        threading.Thread(target=DesktopStream(renderer, surfaces).loop, daemon=True, name="desktop"),
        threading.Thread(target=SlackBridgeStream(renderer, surfaces).loop, daemon=True, name="slack"),
        threading.Thread(target=OpenClawStream(renderer, args.preview_chars, args.history).loop, daemon=True, name="openclaw"),
        threading.Thread(target=ImprovementStream(renderer).loop, daemon=True, name="improve"),
        threading.Thread(target=memory_loop, args=(renderer,), daemon=True, name="memory"),
        threading.Thread(target=immune_source, args=(renderer, HEALTH_LOG, "health"), daemon=True, name="health"),
        threading.Thread(target=immune_source, args=(renderer, INCIDENT_LOG, "incident"), daemon=True, name="incidents"),
        threading.Thread(target=immune_source, args=(renderer, ORCH_LOG, "orch"), daemon=True, name="orchestrator"),
        threading.Thread(target=immune_source, args=(renderer, REMOTE_LOG, "bridge"), daemon=True, name="remote"),
        threading.Thread(target=immune_source, args=(renderer, ADB_LOG, "adb"), daemon=True, name="adb"),
    ]
    for thread in threads:
        thread.start()
    try:
        while any(thread.is_alive() for thread in threads[1:]):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
