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
STARTUP_STAGES = {
    'prewarm_app_ms': (('app', 't00'), ('app', 't07c')),
    't00_to_t01_ms': (('app', 't00'), ('companion', 't01')),
    't01_to_t07_ms': (('companion', 't01'), ('companion', 't07')),
    't00_to_t07c_ms': (('app', 't00'), ('app', 't07c')),
}
PIPELINE_FIELDS = {
    "decision_ms": "decision_ms",
    "capability_ms": "capability_ms",
    "gemini_after_receipt_ms": "gemini_ms",
    "end_to_result_audio_ms": "response_ms",
}


def startup_report(events, drifted, unknown_boundary):
    sessions = defaultdict(dict)
    for event in events:
        if event['sid'] in drifted or event['turn'] != 0:
            continue
        key = (event['src'], event['ev'])
        before = sessions[event['sid']].get(key)
        if before is None or event['boot_ns'] < before:
            sessions[event['sid']][key] = event['boot_ns']
    result = {}
    for label, (start, end) in STARTUP_STAGES.items():
        values, missing = [], 0
        for stamps in sessions.values():
            if start not in stamps or end not in stamps or stamps[end] < stamps[start]:
                missing += 1
            else:
                values.append((stamps[end] - stamps[start]) / 1_000_000)
        result[label] = {**summarize(values), 'p95_ms': round(percentile(values, .95), 2) if len(values) >= 100 else None,
                         'observed_p95_ms': round(percentile(values, .95), 2) if values else None,
                         'missing_sessions': missing, 'p95_qualified': len(values) >= 100}
    ready = [e for e in events if e['src'] == 'companion' and e['ev'] == 't07' and e['turn'] == 0 and e['sid'] not in drifted]
    hits = sum(e['x'].get('cached') is True for e in ready)
    misses = sum(e['x'].get('cached') is False for e in ready)
    return {'schema': 'samantha.voice.startup-latency.v1', 'metrics': result,
            'prewarm_guard': {'observed': len(ready), 'warm_hits': hits, 'warm_misses': misses,
                              'missing_outcome': len(ready) - hits - misses},
            'joinedBy': ['sid', 'src', 'turn=0'], 'clock_drift_excluded_sessions': sorted(drifted),
            'clock_drift_unknown_boundary_sessions': sorted(unknown_boundary),
            'clock_policy': {'untruncated_drift_us': '>1000 absolute', 'legacy_drift_us': '>=1000 absolute',
                             'legacy_exact_1000_reason': 'unknown_truncated_boundary'}}


def pipeline_report(events, drifted):
    rows = [e for e in events if e['src'] == 'companion' and e['ev'] == 't30p'
            and e['turn'] > 0 and e['sid'] not in drifted and e['x'].get('phase') == 1]
    values = {label: [] for label in PIPELINE_FIELDS}
    complete = []
    for event in rows:
        metadata = event['x']
        for label, field in PIPELINE_FIELDS.items():
            value = metadata.get(field)
            if type(value) is int and value >= 0:
                values[label].append(value)
        required = [metadata.get(field) for field in PIPELINE_FIELDS.values()]
        if all(type(value) is int and value >= 0 for value in required):
            complete.append(metadata)
    budget_ms = 5000
    breaches = sum(row['response_ms'] >= budget_ms for row in complete)
    return {
        'schema': 'samantha.voice.pipeline-latency.v1',
        'budget_ms': budget_ms,
        'result_audio_samples': len(rows),
        'complete_samples': len(complete),
        'missing_stage_samples': len(rows) - len(complete),
        'under_budget_samples': len(complete) - breaches,
        'budget_breaches': breaches,
        'metrics': {label: summarize(samples) for label, samples in values.items()},
        'qualification': 'physical_s24_recipe_required',
    }

def read_events(paths):
    events = []
    for path in paths:
        for lineno, raw in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
            line = raw.strip()
            if not line or not line.startswith(("{", "[")):
                # logcat -v raw emits non-JSON banners and unrelated textual logs.
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
            drift = e["x"].get("clock_drift_us")
            if "clock_drift_us" in e["x"] and (type(drift) not in {int, float}
                                                   or type(drift) is float and not math.isfinite(drift)):
                raise ValueError(f"{path}:{lineno}: invalid clock drift metadata")
            if "clock_drift_truncated" in e["x"] and type(e["x"]["clock_drift_truncated"]) is not bool:
                raise ValueError(f"{path}:{lineno}: invalid clock drift representation")
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
    # V2 explicitly marks the non-truncated representation. Never infer precision from a float or sid.
    # Legacy integer 1000 us can cover a measured delta above 1ms, so its boundary remains unknown/excluded.
    drifted, unknown_boundary = set(), set()
    for event in events:
        metadata = event.get("x", {})
        value = abs(metadata.get("clock_drift_us", 0))
        if metadata.get("clock_drift_truncated") is False:
            if value > 1000:
                drifted.add(event["sid"])
        elif value >= 1000:
            drifted.add(event["sid"])
            if value == 1000:
                unknown_boundary.add(event["sid"])
    for e in events:
        if e["sid"] in drifted:
            continue
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
        "clock_drift_excluded_sessions": sorted(drifted),
        "clock_drift_unknown_boundary_sessions": sorted(unknown_boundary),
        "metrics": {name: {**summarize(durations[name]), "missing_turns": missing[name]} for name in STAGES},
        "startup": startup_report(events, drifted, unknown_boundary),
        "pipeline": pipeline_report(events, drifted),
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
