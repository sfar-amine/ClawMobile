#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest import mock

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


    def test_transient_unavailable_is_distinct_from_quota(self):
        self.assertEqual(
            mod.classify_failure('503 code=UNAVAILABLE', ''),
            'transient_unavailable',
        )
        self.assertEqual(
            mod.classify_failure('429 RESOURCE_EXHAUSTED', ''),
            'quota_exhausted',
        )

    def test_efficiency_policy_requires_minimal_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            workspace = root / "gemini"
            (workspace / ".openclaw").mkdir(parents=True)
            (workspace / ".openclaw/settings.json").write_text(json.dumps({
                "retry": {"provider": {"maxRetries": 0}}
            }))
            value = config()
            value["agents"]["entries"][mod.AGENT].update({
                "workspace": str(workspace),
                "contextInjection": "never",
                "bootstrapMaxChars": mod.EXPECTED_BOOTSTRAP_MAX,
                "bootstrapTotalMaxChars": mod.EXPECTED_BOOTSTRAP_TOTAL,
                "thinkingDefault": "low",
                "fastModeDefault": True,
                "skills": [],
                "tools": {"allow": ["clawmobile_capability"]},
            })
            path = root / "config.json"
            path.write_text(json.dumps(value))
            mod.ensure_efficiency_policy(path, workspace)

    def test_provider_call_forces_low_thinking(self):
        completed = __import__("subprocess").CompletedProcess([], 0, "{}", "")
        with mock.patch.object(mod.subprocess, "run", return_value=completed) as run:
            mod.provider_call("hello", "s", 10)
        command = run.call_args.args[0]
        self.assertIn("--thinking", command)
        self.assertEqual(command[command.index("--thinking") + 1], "low")

    def test_fast_path_hit_does_not_call_provider(self):
        import io
        with tempfile.TemporaryDirectory() as td:
            old_state = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                with mock.patch.object(mod, "ensure_free_policy"),                      mock.patch.object(mod, "ensure_efficiency_policy"),                      mock.patch.object(mod, "fast_path_request", return_value={
                         "status": "hit",
                         "text": "Précise : recharge / balances",
                         "target": "maxit-tunisie",
                         "intent": "telecom.balance",
                         "route": "orange.silent_first.balance",
                     }),                      mock.patch.object(mod, "provider_call") as provider,                      mock.patch.object(sys, "argv", ["gemini-request.py", "mon", "solde", "maxit"]),                      mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    rc = mod.main()
                result = json.loads(output.getvalue())
            finally:
                mod.STATE = old_state
        self.assertEqual(rc, 0)
        self.assertEqual(result["provider_attempts"], 0)
        self.assertEqual(result["source"], "deterministic")
        provider.assert_not_called()

    def test_quota_failure_does_not_retry(self):
        import io
        import subprocess
        failed = subprocess.CompletedProcess([], 1, "429 RESOURCE_EXHAUSTED", "")
        with tempfile.TemporaryDirectory() as td:
            old_state = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                with mock.patch.object(mod, "ensure_free_policy"),                      mock.patch.object(mod, "ensure_efficiency_policy"),                      mock.patch.object(mod, "fast_path_request", return_value={"status": "miss"}),                      mock.patch.object(mod, "compact_memory", return_value=(7, [])),                      mock.patch.object(mod, "provider_call", return_value=failed) as provider,                      mock.patch.object(sys, "argv", ["gemini-request.py", "hello"]),                      mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    rc = mod.main()
                result = json.loads(output.getvalue())
            finally:
                mod.STATE = old_state
        self.assertEqual(rc, 75)
        self.assertEqual(result["reason"], "quota_exhausted")
        self.assertEqual(result["provider_attempts"], 1)
        provider.assert_called_once()

    def test_transient_failure_retries_once(self):
        import io
        import subprocess
        failed = subprocess.CompletedProcess([], 1, "503 code=UNAVAILABLE", "")
        success = subprocess.CompletedProcess([], 0, '{"status":"ok"}', "")
        with tempfile.TemporaryDirectory() as td:
            old_state = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                with mock.patch.object(mod, "ensure_free_policy"),                      mock.patch.object(mod, "ensure_efficiency_policy"),                      mock.patch.object(mod, "fast_path_request", return_value={"status": "miss"}),                      mock.patch.object(mod, "compact_memory", return_value=(7, [])),                      mock.patch.object(mod, "provider_call", side_effect=[failed, success]) as provider,                      mock.patch.object(mod, "compact_success", return_value={
                         "status": "ok",
                         "text": "OK",
                         "provider_attempts": 2,
                     }),                      mock.patch.object(mod.time, "sleep"),                      mock.patch.object(sys, "argv", ["gemini-request.py", "hello"]),                      mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    rc = mod.main()
                result = json.loads(output.getvalue())
            finally:
                mod.STATE = old_state
        self.assertEqual(rc, 0)
        self.assertEqual(result["provider_attempts"], 2)
        self.assertEqual(provider.call_count, 2)


    def test_capability_hint_is_compact_and_surface_scoped(self):
        import subprocess
        payload = {
            "capability_revision": "abc123",
            "capability": "telecom.orange.consultation",
            "selected": {
                "executor": "claw.skill_route",
                "route": "orange.silent_first.balance",
                "state": "ready",
                "risk": "read",
                "deterministic": True,
                "entrypoint": "hidden",
            },
            "matches": [
                {"id": "telecom.orange.consultation", "name": "Orange", "score": 1.0, "notes": "hidden"}
            ],
        }
        completed = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
        with mock.patch.object(mod.subprocess, "run", return_value=completed) as run:
            hint = mod.capability_hint("mon solde orange")
        self.assertEqual(hint["capability"], "telecom.orange.consultation")
        self.assertNotIn("entrypoint", hint["selected"])
        self.assertNotIn("notes", hint["matches"][0])
        argv = run.call_args.args[0]
        self.assertIn("gemini_claw", argv)

    def test_prompt_mentions_single_capability_tool_when_hint_present(self):
        prompt = mod.build_prompt(
            "mon solde orange",
            42,
            [],
            {"capability": "telecom.orange.consultation", "selected": {"executor": "claw.skill_route"}},
        )
        self.assertIn("clawmobile_capability", prompt)
        self.assertIn("CAPABILITY_HINT=", prompt)


if __name__ == "__main__":
    unittest.main()
