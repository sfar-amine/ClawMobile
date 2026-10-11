#!/usr/bin/env python3
"""O9: the Companion acceptance line rejects a voice run left unknown with a final transcript.
Real shape: openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o9-voice-unknown-runs.json (S24 runs.json, 3 runs)."""
import importlib.util, json, pathlib, unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("companion_acceptance", HERE / "companion-acceptance.py")
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
CAPTURE = json.loads((HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o9-voice-unknown-runs.json").read_text(encoding="utf-8"))


def listed(state):
    return json.dumps({"runs": [{"runId": r["runId"], "modality": "voice", "state": state(r), "transcriptState": r["transcriptState"]}
                                for r in CAPTURE["runs"]]}).encode()


class VoiceTerminalAcceptance(unittest.TestCase):
    def test_captured_unknown_runs_are_reported(self):
        self.assertEqual(acceptance.voice_terminal_unknown(listed(lambda r: r["state"])), [r["runId"] for r in CAPTURE["runs"]])

    def test_reconciled_runs_pass(self):
        self.assertEqual(acceptance.voice_terminal_unknown(listed(lambda r: "done")), [])

    def test_partial_and_text_runs_are_not_judged(self):
        body = json.dumps({"runs": [{"runId": "voice_partial", "modality": "voice", "state": "unknown", "transcriptState": "partial"},
                                    {"runId": "run_text", "state": "unknown"}]}).encode()
        self.assertEqual(acceptance.voice_terminal_unknown(body), [])

    def test_invalid_projection_is_not_accepted(self):
        self.assertIsNone(acceptance.voice_terminal_unknown(b"[]"))
        self.assertIsNone(acceptance.voice_terminal_unknown(b'{"runs": {}}'))

    def test_body_without_run_list_is_skipped_not_failed(self):
        def call(method, path, timeout, headers=None):
            return (403, b"{}", 0.01) if method != "GET" else ((200, b"{}", 0.05) if path == acceptance.VOICE_TERMINAL_ROUTE else (404, b"", 0.01))
        with mock.patch.object(acceptance, "call", side_effect=call), mock.patch("builtins.print") as printed:
            self.assertEqual(acceptance.main(), 0)
        row = next(c for c in json.loads(printed.call_args.args[0])["checks"] if c.get("check") == "voice_runs_terminal_state")
        self.assertEqual(row["status"], "skipped")

    def test_main_fails_on_stale_voice_run_and_passes_after_reconciliation(self):
        def fake_call(stale):
            def call(method, path, timeout, headers=None):
                if method != "GET":
                    return 403, b"{}", 0.01
                if path == acceptance.VOICE_TERMINAL_ROUTE:
                    return 200, listed(lambda r: r["state"] if stale else "done"), 0.05
                return 404, b"", 0.01
            return call
        for stale, expected in ((True, 1), (False, 0)):
            with self.subTest(stale=stale), mock.patch.object(acceptance, "call", side_effect=fake_call(stale)), \
                    mock.patch("builtins.print") as printed:
                self.assertEqual(acceptance.main(), expected)
            report = json.loads(printed.call_args.args[0])
            row = next(c for c in report["checks"] if c.get("check") == "voice_runs_terminal_state")
            self.assertEqual(row["status"], "fail" if stale else "ok")
            self.assertEqual(row["unknown_terminal"], 3 if stale else 0)


if __name__ == "__main__":
    unittest.main()
