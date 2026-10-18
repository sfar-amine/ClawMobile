#!/usr/bin/env python3
"""F3 (doc 62): rebuild one time window across the S24 owners, in order, in one command.

    claw-trace.py [--minutes 15 | --since 23:30 [--until 23:40]] [--no-app] [--json]

    claw-trace.py <correlation> | --turn ID | --run ID | --client-run ID

Reads only what the existing owners already write — no daemon, no new store:
  companion  ~/.openclaw/health/companion.stderr.log*   (lines stamped by bounded-log.py --timestamp)
  health     ~/.openclaw/health/health.log*
  app        files/voice-trace.jsonl* of the app (adb run-as), telemetry C1: codes and timings only
  dialogue   transitions of ~/.openclaw/samantha-dialogue/dialogue.sqlite
  runs       ~/.openclaw/clawmobile-companion/runs.json (state, source, capability, error — never the user's text)
"""
import argparse
import datetime as dt
import json
import os
import re
import runpy
import sqlite3
import subprocess
import sys
from pathlib import Path

HOME = Path(os.environ.get("HOME", "~")).expanduser()
OC = HOME / ".openclaw"
APP = os.environ.get("SAMANTHA_APP_PACKAGE", "ai.samantha.android.dev")
DEVICE = os.environ.get("SAMANTHA_ADB_DEVICE", "127.0.0.1:5556")
STAMP = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:[+-]\d\d:\d\d|Z)?)\s+(.*)$")
LOCAL = dt.datetime.now().astimezone().tzinfo
# Reuse the existing sink's ID bounds, rather than introducing another Python definition.
CORRELATION_VALUE = runpy.run_path(str(Path(__file__).with_name("bounded-log.py")))["CORRELATION_VALUE"]


def instant(text):
    value = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    return value if value.tzinfo else value.replace(tzinfo=LOCAL)


def from_ms(ms):
    return dt.datetime.fromtimestamp(ms / 1000, LOCAL)


def rotated(path):
    return [p for p in [path] + [path.with_name(path.name + "." + str(n)) for n in range(1, 4)] if p.is_file()]


def stamped_lines(source, path):
    for file in rotated(path):
        try:
            text = file.read_text(errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            match = STAMP.match(line)
            if match:
                try:
                    yield instant(match.group(1)), source, match.group(2).strip()
                except ValueError:
                    continue


LOGCAT = re.compile(r"^\s*(\d+\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+(SamanthaVoiceT?)\s*:\s?(.*)$")


def app_logcat():
    # The installed APK is an optimized, non-debuggable build: run-as is refused there (S24 18/10 10:06), so the
    # voice owner's own log lines (voice_start, voice_fail:<message>:<cause>) are the trace that is always readable.
    try:
        out = subprocess.run(["adb", "-s", DEVICE, "logcat", "-d", "-v", "epoch", "-s", "SamanthaVoice:V", "SamanthaVoiceT:V"],
                             capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in out.splitlines():
        match = LOGCAT.match(line)
        if match:
            at = dt.datetime.fromtimestamp(float(match.group(1)), LOCAL)
            rows.append((at, "app", f"{match.group(3)} {match.group(2)} {match.group(4)[:200]}"))
    return rows


def app_trace():
    rows = []
    for name in ("files/voice-trace.jsonl.1", "files/voice-trace.jsonl"):
        try:
            done = subprocess.run(["adb", "-s", DEVICE, "shell", "run-as", APP, "cat", name],
                                  capture_output=True, text=True, timeout=15)
            out = done.stdout
        except (OSError, subprocess.SubprocessError):
            return rows
        if "not debuggable" in done.stdout + done.stderr:
            return app_logcat()
        for line in out.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("schema") != "samantha.voice.telemetry.v1" or not isinstance(row.get("wall_ms"), int):
                continue
            extra = json.dumps(row.get("x") or {}, ensure_ascii=False, separators=(",", ":"))[:200]
            rows.append((from_ms(row["wall_ms"]), "app", f"{row.get('ev')} turn={row.get('turn')} sid={str(row.get('sid'))[:8]} {extra}"))
    return rows


def dialogue(since_ms, until_ms):
    path = OC / "samantha-dialogue" / "dialogue.sqlite"
    if not path.is_file():
        return []
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        rows = db.execute("select at,goal_ref,event_kind,to_state,outcome,reason_code from transitions "
                          "where at between ? and ? order by id", (since_ms, until_ms)).fetchall()
    except sqlite3.Error:
        return []
    return [(from_ms(at), "dialogue", f"{kind} → {state} {outcome} {reason or ''} {goal}".strip())
            for at, goal, kind, state, outcome, reason in rows]


def runs(since_ms, until_ms):
    path = OC / "clawmobile-companion" / "runs.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    items = data.get("runs", data) if isinstance(data, dict) else data
    items = list(items.values()) if isinstance(items, dict) else items
    out = []
    for run in items if isinstance(items, list) else []:
        if not isinstance(run, dict):
            continue
        capability = (run.get("decision") or {}).get("capability") or "-"
        for key, label in (("acceptedAt", "accepted"), ("updatedAt", run.get("state"))):
            at = run.get(key)
            if isinstance(at, int) and since_ms <= at <= until_ms:
                # Existing run owner fields, not a new correlation index. Never copy a free error string.
                fields = " ".join(f"{key}={run[key]}" for key in ("runId", "clientRunId", "turnId")
                                  if isinstance(run.get(key), str) and CORRELATION_VALUE.fullmatch(run[key]))
                reason = run.get("reasonClass") or ""
                reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,95}", reason) else ""
                out.append((from_ms(at), "runs", f"{label} {fields} source={run.get('executionSource')} capability={capability} {reason}".strip()))
    return out


def window(args):
    now = dt.datetime.now(LOCAL)
    def clock(text):
        if re.fullmatch(r"\d\d:\d\d(:\d\d)?", text):
            return dt.datetime.combine(now.date(), dt.time.fromisoformat(text), LOCAL)
        return instant(text)
    since = clock(args.since) if args.since else now - dt.timedelta(minutes=args.minutes)
    until = clock(args.until) if args.until else now
    return since, until


CORRELATION_KEYS = {
    "turn": ("turnId", "turn_id", "turn"),
    "run": ("runId", "run_id", "run"),
    "client_run": ("clientRunId", "client_run_id"),
}


def has_correlation(text, value, keys):
    # Exact named fields only: run_1 never matches run_10, message text or a timestamp.
    for key in keys:
        pattern = r'(?<![A-Za-z0-9_])"?' + re.escape(key) + r'"?\s*[:=]\s*"?' + re.escape(value) + r'(?=["\s,}]|$)'
        if re.search(pattern, text):
            return True
    return False


def correlated(text, args):
    if args.correlation and not has_correlation(text, args.correlation, sum(CORRELATION_KEYS.values(), ())):
        return False
    return all(not getattr(args, name) or has_correlation(text, getattr(args, name), keys)
               for name, keys in CORRELATION_KEYS.items())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("correlation", nargs="?")
    parser.add_argument("--turn")
    parser.add_argument("--run")
    parser.add_argument("--client-run", dest="client_run")
    parser.add_argument("--minutes", type=int, default=15)
    parser.add_argument("--since")
    parser.add_argument("--until")
    parser.add_argument("--no-app", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    for value in (args.correlation, args.turn, args.run, args.client_run):
        if value is not None and not CORRELATION_VALUE.fullmatch(value):
            parser.error("invalid_trace_correlation")
    since, until = window(args)
    s_ms, u_ms = int(since.timestamp() * 1000), int(until.timestamp() * 1000)
    rows = []
    rows += stamped_lines("companion", OC / "health" / "companion.stderr.log")
    rows += stamped_lines("health", OC / "health" / "health.log")
    if not args.no_app:
        rows += app_trace()
    rows += dialogue(s_ms, u_ms)
    rows += runs(s_ms, u_ms)
    rows = sorted((r for r in rows if since <= r[0] <= until and correlated(r[2], args)), key=lambda r: r[0])
    for at, source, text in rows:
        if args.json:
            print(json.dumps({"at": at.isoformat(timespec="milliseconds"), "source": source, "text": text}, ensure_ascii=False))
        else:
            print(f"{at.strftime('%H:%M:%S.%f')[:-3]} {source:<9} {text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
