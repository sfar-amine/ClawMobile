#!/usr/bin/env python3
"""HS8 (17/10): the Companion acceptance line reads /catalog inputs.voiceMemo (composer microphone).
Shape: catalogProjection in openclaw-plugin-mobile-ui/src/companion/catalog.ts, gated by the S24 receipt
fixtures/s24-2026-10-17/hs8-qualification/qualification-receipt.json."""
import importlib.util, json, pathlib, unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("companion_acceptance", HERE / "companion-acceptance.py")
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)
RECEIPT = json.loads((HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-17/hs8-qualification/qualification-receipt.json").read_text(encoding="utf-8"))


def catalog(memo):
    return json.dumps({"version": 1, "themes": [], "inputs": {"voiceMemo": memo}}).encode()


class VoiceMemoAcceptance(unittest.TestCase):
    def test_receipt_is_the_qualified_owner(self):
        self.assertEqual(RECEIPT["owner"]["model"], "gemini-3.5-flash-lite")
        self.assertFalse(RECEIPT["openaiCalled"])

    def test_coherent_projection(self):
        self.assertIs(acceptance.voice_memo_input(catalog({"available": True, "availability": "available"})), True)
        self.assertIs(acceptance.voice_memo_input(catalog({"available": False, "availability": "soon"})), False)

    def test_malformed_projection(self):
        for memo in (None, True, {"available": "yes", "availability": "available"}, {"available": True, "availability": "soon"},
                     {"available": False, "availability": "available"}, {"available": True}):
            self.assertIsNone(acceptance.voice_memo_input(catalog(memo)), memo)
        self.assertIsNone(acceptance.voice_memo_input(b"[]"))
        self.assertIsNone(acceptance.voice_memo_input(b"not json"))
        self.assertIsNone(acceptance.voice_memo_input(json.dumps({"inputs": {}}).encode()))

    def test_catalog_without_inputs_is_skipped(self):
        self.assertEqual(acceptance.voice_memo_input(b"{}"), "absent")

    def run_main(self, memo):
        def call(method, path, timeout, headers=None):
            if method != "GET":
                return 403, b"{}", 0.01
            return (200, catalog(memo), 0.05) if path == "/catalog" else (404, b"", 0.01)
        with mock.patch.object(acceptance, "call", side_effect=call), mock.patch("builtins.print") as printed:
            code = acceptance.main()
        report = json.loads(printed.call_args.args[0])
        return code, next(c for c in report["checks"] if c.get("check") == "voice_memo_input"), report["warnings"]

    def test_main_accepts_qualified_microphone(self):
        code, row, warnings = self.run_main({"available": True, "availability": "available"})
        self.assertEqual((code, row["status"], row["available"]), (0, "ok", True))
        self.assertFalse([w for w in warnings if w["warning"] == "voice_memo_unavailable"])

    def test_closed_microphone_warns_without_rollback(self):
        code, row, warnings = self.run_main({"available": False, "availability": "soon"})
        self.assertEqual((code, row["status"]), (0, "ok"))
        self.assertIn({"route": "/catalog", "warning": "voice_memo_unavailable"}, warnings)

    def test_malformed_microphone_rolls_back(self):
        code, row, _ = self.run_main({"available": True, "availability": "soon"})
        self.assertEqual((code, row["status"]), (1, "fail"))


if __name__ == "__main__":
    unittest.main()
