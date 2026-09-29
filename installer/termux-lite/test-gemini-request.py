#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gemini_request", HERE / "gemini-request.py")
mod = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(mod)


def config() -> dict:
    return {
        "auth": {"profiles": {
            mod.PROFILE: {"provider": "google", "mode": "api_key"}
        }},
        "agents": {"entries": {
            mod.AGENT: {
                "model": {"primary": f"{mod.MODEL}@{mod.PROFILE}", "fallbacks": []},
                "modelPolicy": {"allow": [mod.MODEL]},
            }
        }},
    }


class GeminiRequestTests(unittest.TestCase):
    def test_conceptual_api_key_text_is_allowed(self):
        self.assertFalse(mod.secret_like("Explain what an API key is."))

    def test_google_key_is_refused(self):
        self.assertTrue(mod.secret_like("AIza" + "A" * 32))

    def test_card_number_is_refused(self):
        self.assertTrue(mod.secret_like("4111 1111 1111 1111"))
    def test_exact_free_policy_passes(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.json"
            path.write_text(json.dumps(config()))
            mod.ensure_free_policy(path)

    def test_fallback_is_refused(self):
        value = config()
        value["agents"]["entries"][mod.AGENT]["model"]["fallbacks"] = ["openai/gpt-5.6-luna"]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.json"
            path.write_text(json.dumps(value))
            with self.assertRaises(mod.PolicyError):
                mod.ensure_free_policy(path)

    def test_quota_is_classified_without_retry(self):
        self.assertEqual(
            mod.classify_failure('{"error":"429 RESOURCE_EXHAUSTED"}', ""),
            "quota_exhausted",
        )

    def test_compact_success_verifies_provider_and_zero_cost(self):
        envelope = {
            "status": "ok",
            "result": {
                "payloads": [{"text": "OK"}],
                "meta": {"agentMeta": {
                    "provider": "google",
                    "model": mod.MODEL_ID,
                    "costUsd": 0,
                    "usage": {"input": 12, "output": 1, "total": 13},
                    "terminalReceipt": {
                        "effective": {"provider": "google", "model": mod.MODEL_ID},
                        "rerouted": False,
                    },
                }},
            },
        }
        with tempfile.TemporaryDirectory() as td:
            old = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                out = mod.compact_success(json.dumps(envelope), 7)
            finally:
                mod.STATE = old
        self.assertEqual(out["text"], "OK")
        self.assertEqual(out["reported_cost_usd"], 0)
    def test_nonzero_cost_is_refused(self):
        envelope = {
            "status": "ok",
            "result": {
                "payloads": [{"text": "OK"}],
                "meta": {"agentMeta": {
                    "provider": "google",
                    "model": mod.MODEL_ID,
                    "costUsd": 0.01,
                    "terminalReceipt": {
                        "effective": {"provider": "google", "model": mod.MODEL_ID},
                        "rerouted": False,
                    },
                }},
            },
        }
        with tempfile.TemporaryDirectory() as td:
            old = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                with self.assertRaises(mod.PolicyError):
                    mod.compact_success(json.dumps(envelope), 7)
            finally:
                mod.STATE = old

    def test_reroute_is_refused(self):
        envelope = {
            "status": "ok",
            "result": {
                "payloads": [{"text": "OK"}],
                "meta": {"agentMeta": {
                    "provider": "google",
                    "model": mod.MODEL_ID,
                    "costUsd": 0,
                    "terminalReceipt": {
                        "effective": {"provider": "google", "model": mod.MODEL_ID},
                        "rerouted": True,
                    },
                }},
            },
        }
        with tempfile.TemporaryDirectory() as td:
            old = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                with self.assertRaises(mod.PolicyError):
                    mod.compact_success(json.dumps(envelope), 7)
            finally:
                mod.STATE = old


if __name__ == "__main__":
    unittest.main()
