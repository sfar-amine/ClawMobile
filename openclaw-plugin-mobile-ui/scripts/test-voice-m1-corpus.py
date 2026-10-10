#!/usr/bin/env python3
"""Contract tests for Samantha M1 corpus and internal telemetry statistics."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("voice_m1_analyze", ROOT / "voice-m1-analyze.py")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)
CORPUS = ROOT / "fixtures" / "samantha-voice-corpus-v1.jsonl"
CATEGORIES = {
    "silence", "noise_short", "noise_continuous", "background_speech",
    "speaker_echo", "bargein_true", "bargein_false", "short_word",
    "lang_fr", "lang_en", "lang_ar", "lang_tn", "mixed", "named_entity",
    "foreign_script", "guard_reject", "network", "late_receipt",
    "action_capability",
}
EXPECTATIONS = {"accept", "reject", "interrupt", "no_interrupt", "respond", "no_effect"}

def event(sid, turn, ev, boot_ns, src="app"):
    return {"schema": analysis.SCHEMA, "src": src, "sid": sid,
            "turn": turn, "ev": ev, "boot_ns": boot_ns,
            "wall_ms": 1791540000000, "x": {}}

class VoiceM1CorpusTests(unittest.TestCase):
    def test_c3_corpus_schema_and_coverage(self):
        rows = [json.loads(s) for s in CORPUS.read_text(encoding="utf-8").splitlines() if s.strip()]
        self.assertGreaterEqual(len(rows), 20)
        ids = set()
        categories = set()
        for row in rows:
            self.assertEqual(set(row), {"id", "cat", "lang", "stimulus", "expect", "origin"})
            self.assertTrue(all(isinstance(value, str) and value for value in row.values()))
            self.assertNotIn(row["id"], ids)
            self.assertIn(row["cat"], CATEGORIES)
            self.assertIn(row["expect"], EXPECTATIONS)
            ids.add(row["id"])
            categories.add(row["cat"])
        self.assertTrue(CATEGORIES <= categories)
        self.assertEqual(next(row for row in rows if row["id"] == "guard-es-que-noise")["expect"], "reject")
        self.assertTrue(any(row["cat"] == "lang_tn" and row["lang"] == "tn" for row in rows))

    def test_cross_source_single_clock_internal_decomposition(self):
        sample = [event("sessionA", 2, "t25", 1_000_000_000),
                  event("sessionA", 2, "t25p", 1_018_000_000, "companion"),
                  event("sessionA", 2, "t30p", 2_000_000_000, "companion"),
                  event("sessionA", 2, "t30", 2_040_000_000),
                  event("sessionA", 2, "t31", 2_060_000_000),
                  event("sessionA", 2, "t32", 2_080_000_000)]
        r = analysis.analyze(sample)
        self.assertEqual(r["sessions"], 1)
        self.assertEqual(r["turns"], 1)
        self.assertEqual(r["metrics"]["app_activity_end_to_relay_ms"]["p50_ms"], 18.0)
        self.assertEqual(r["metrics"]["provider_audio_to_app_ms"]["p50_ms"], 40.0)
        self.assertEqual(r["metrics"]["audiotrack_write_to_present_ms"]["p50_ms"], 20.0)
        self.assertNotIn("p95_ms", r["metrics"]["app_activity_end_to_relay_ms"])
        self.assertIn("external", r["warning"].lower())

    def test_never_cross_correlates_other_sessions_or_turns(self):
        r = analysis.analyze([event("sid-1", 0, "t41", 100),
                              event("sid-1", 1, "t43", 150),
                              event("sid-2", 0, "t43", 200)])
        self.assertEqual(r["metrics"]["barge_detect_to_stop_ms"]["n"], 0)

    def test_p95_only_for_100_or_more_observations(self):
        self.assertNotIn("p95_ms", analysis.summarize(list(range(30))))
        self.assertIn("p95_ms", analysis.summarize(list(range(100))))

    def test_reader_rejects_wrong_timestamp_basis(self):
        bad = event("sid", 1, "t21", "not_nanos")
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "bad.jsonl"
            p.write_text(json.dumps(bad) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "CLOCK_BOOTTIME"):
                analysis.read_events([p])

    def test_reader_accepts_both_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "events.jsonl"
            p.write_text("\n".join([json.dumps(event("a", 0, "t25", 100)),
                                      json.dumps(event("a", 0, "t25p", 500, "companion"))]) + "\n",
                         encoding="utf-8")
            self.assertEqual(len(analysis.read_events([p])), 2)

    def test_reader_ignores_non_json_logcat_lines_but_rejects_malformed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "logcat.jsonl"
            p.write_text("--------- beginning of main\ntextual log\n" + json.dumps(event("a", 0, "t00", 100)) + "\n", encoding="utf-8")
            self.assertEqual(len(analysis.read_events([p])), 1)
            p.write_text("--------- beginning of main\n{broken JSON\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, ":2: invalid JSON"):
                analysis.read_events([p])

    def test_closing_drift_excludes_whole_session_including_other_turns(self):
        events = [event("bad", 1, "t25", 100), event("bad", 1, "t25p", 200, "companion"),
                  event("good", 1, "t25", 100), event("good", 1, "t25p", 200, "companion")]
        drift = event("bad", 2, "t44", 300, "companion")
        for amount in [-2000, 1001, 1000]:
            drift["x"] = {"clock_drift_us": amount}
            r = analysis.analyze(events + [drift])
            self.assertEqual(r["clock_drift_excluded_sessions"], ["bad"])
            self.assertEqual(r["sessions"], 1)
            self.assertEqual(r["metrics"]["app_activity_end_to_relay_ms"]["n"], 1)

    def test_invalid_drift_annotation_rejected_with_diagnostic(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "drift.jsonl"
            for value in ["not_a_number", True, None, float("nan"), float("inf")]:
                e = event("a", 1, "t44", 100)
                e["x"] = {"clock_drift_us": value}
                p.write_text(json.dumps(e) + "\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, ":1: invalid clock drift"):
                    analysis.read_events([p])

    def test_setup_events_correlate_at_turn_zero(self):
        r = analysis.analyze([event("setup", 0, "t00", 100), event("setup", 0, "t07c", 1000100),
                              event("setup", 0, "t01", 100, "companion"), event("setup", 0, "t07", 2000100, "companion")])
        self.assertEqual(r["metrics"]["prewarm_app_ms"]["n"], 1)
        self.assertEqual(r["metrics"]["prewarm_to_ready_ms"]["n"], 1)

if __name__ == "__main__":
    unittest.main()
