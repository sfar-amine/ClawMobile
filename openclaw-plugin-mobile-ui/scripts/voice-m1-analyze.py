#!/usr/bin/env python3
"""M1 internal voice telemetry analyzer, contract samantha.voice.telemetry.v1.

Input: SamanthaVoiceT logcat (-v raw) and Companion JSONL. All timestamps are
CLOCK_BOOTTIME in nanoseconds on the same S24. No audio/transcripts processed.
Real speech boundaries t20/t23/t40 require an external aligned recording;
this tool never substitutes VAD timestamps for those references.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

SCHEMA = "samantha.voice.telemetry.v1"
STAGES = {
    "prewarm_to_ready_ms": ("t01", "t07"),
    "token_helper_ms": ("t02", "t03"),
    "provider_websocket_ms": ("t04", "t05"),
    "prewarm_app_ms": ("t00", "t07c"),
    "app_activity_end_to_relay_ms": ("t25", "t25p"),
    "provider_audio_to_app_ms": ("t30p", "t30"),
    "audiotrack_write_to_present_ms": ("t31", "t32"),
    "barge_detect_to_stop_ms": ("t41", "t43"),
}

def read_events(paths):
    events = []
    for path in paths:
        for lineno, raw in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
            line = raw.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError as ex:
                raise ValueError(f"{path}:{lineno}: invalid JSON") from ex
            if not isinstance(e, dict) or e.get("schema") != SCHEMA:
                raise ValueError(f"{path}:{lineno}: unexpected telemetry schema")
            if e.get("src") not in {"app", "companion"}:
                raise ValueError(f"{path}:{lineno}: invalid src")
            if not isinstance(e.get("sid"), str) or not e["sid"]:
                raise ValueError(f"{path}:{lineno}: missing sid")
            if not isinstance(e.get("ev"), str):
                raise ValueError(f"{path}:{lineno}: missing event name")
            if type(e.get("boot_ns")) is not int or e["boot_ns"] < 0:
                raise ValueError(f"{path}:{lineno}: invalid CLOCK_BOOTTIME")
            if type(e.get("turn")) is not int or e["turn"] < 0:
                raise ValueError(f"{path}:{lineno}: invalid turn")
            if not isinstance(e.get("x"), dict):
                raise ValueError(f"{path}:{lineno}: invalid technical metadata")
            events.append(e)
    return events

def percentile(values, percentile_rank):
    if not values:
        return None
    s = sorted(values)
    rank = (len(s) - 1) * percentile_rank
    low, high = math.floor(rank), math.ceil(rank)
    return s[low] + (s[high] - s[low]) * (rank - low)

def summarize(values):
    if not values:
        return {"n": 0}
    report = {
        "n": len(values),
        "p50_ms": round(percentile(values, .50), 2),
        "p90_ms": round(percentile(values, .90), 2),
        "max_ms": round(max(values), 2),
    }
    if len(values) >= 100:
        report["p95_ms"] = round(percentile(values, .95), 2)
    return report

def analyze(events):
    by_turn = defaultdict(dict)
    for e in events:
        key = (e["sid"], e["turn"])
        # Earliest event of a given name wins; no cross-session alignment.
        t = by_turn[key].get(e["ev"])
        if t is None or e["boot_ns"] < t:
            by_turn[key][e["ev"]] = e["boot_ns"]
    durations = defaultdict(list)
    missing = defaultdict(int)
    for stamps in by_turn.values():
        for label, (start, end) in STAGES.items():
            if start not in stamps or end not in stamps:
                missing[label] += 1
            elif stamps[end] >= stamps[start]:
                durations[label].append((stamps[end] - stamps[start]) / 1_000_000)
            else:
                missing[label] += 1
    return {
        "schema": "samantha.voice.m1.internal-analysis.v1",
        "sessions": len({sid for sid, _ in by_turn}),
        "turns": len(by_turn),
        "metrics": {name: {**summarize(durations[name]), "missing_turns": missing[name]} for name in STAGES},
        "external_reference_required": {
            "real_speech_end_to_first_audible_ms": "t23_external_to_t32",
            "barge_detect_ms": "t40_external_to_t41",
            "barge_e2e_ms": "t40_external_to_t43",
        },
        "warning": "Internal CLOCK_BOOTTIME decomposition only; no externally grounded user latency KPI.",
    }

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input", nargs="+", help="S24 app Logcat JSONL and/or Companion JSONL")
    p.add_argument("--out", help="Optional output JSON; by default prints summary")
    ns = p.parse_args(argv)
    output = json.dumps(analyze(read_events(ns.input)), ensure_ascii=False, indent=2) + "\n"
    if ns.out:
        Path(ns.out).write_text(output, encoding="utf-8")
    else:
        print(output, end="")

if __name__ == "__main__":
    main()
