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

# O8: real S24 capture of the 10/10 09:41 "Mon solde Orange" run and the current gemini_claw resolution and
# capability_hint() output (resolution only, no operator call, no provider_call). Provenance:
# openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/README.md (core runtime 5de1c49).
CAPTURE = json.loads((HERE.parents[1] / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json").read_text(encoding="utf-8"))


def captured_fast_path_hit() -> dict:
    """Fast-path hit for gemini_claw built from the captured selection and cards (text derived, one card per line)."""
    selected = CAPTURE["resolution_now"]["gemini_claw"]["selected"]
    cards = CAPTURE["client_received_result"]["data"]["cards"]
    return {
        "status": "hit",
        "text": "\n".join(f"{c['title']} : {c['value']} {c['unit']}" for c in cards),
        "result": CAPTURE["client_received_result"],
        "target": selected["target"],
        "intent": selected["intent"],
        "route": selected["route"],
        "capability": selected["capability"],
    }


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
                with mock.patch.object(mod, "ensure_free_policy"),                      mock.patch.object(mod, "ensure_efficiency_policy"),                      mock.patch.object(mod, "fast_path_request", return_value=captured_fast_path_hit()),                      mock.patch.object(mod, "provider_call") as provider,                      mock.patch.object(sys, "argv", ["gemini-request.py", *CAPTURE["companion_run"]["userText"].split()]),                      mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    rc = mod.main()
                result = json.loads(output.getvalue())
            finally:
                mod.STATE = old_state
        self.assertEqual(rc, 0)
        self.assertEqual(result["provider_attempts"], 0)
        self.assertEqual(result["source"], "deterministic")
        self.assertEqual(result["fast_path"], {"target": "maxit-tunisie", "intent": "telecom.balance", "route": "orange.summary.maxit.v1"})
        self.assertEqual(result["text"].count("\n"), 7)
        self.assertEqual((result["reported_cost_usd"], result["rerouted"]), (0, False))
        provider.assert_not_called()

    def test_known_error_does_not_call_provider(self):
        import io
        with tempfile.TemporaryDirectory() as td:
            old_state = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                with mock.patch.object(mod, "ensure_free_policy"), \
                     mock.patch.object(mod, "ensure_efficiency_policy"), \
                     mock.patch.object(mod, "fast_path_request", return_value={
                         "status": "known_error",
                         "text": "Claw connaît cette action mais son exécution est indisponible.",
                     }) as fast, \
                     mock.patch.object(mod, "provider_call") as provider, \
                     mock.patch.object(sys, "argv", ["gemini-request.py", "--caller", "owner", "action", "connue"]), \
                     mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    rc = mod.main()
                result = json.loads(output.getvalue())
            finally:
                mod.STATE = old_state
        self.assertEqual(rc, 0)
        self.assertEqual(result["provider_attempts"], 0)
        self.assertEqual(result["text"], "Claw connaît cette action mais son exécution est indisponible.")
        provider.assert_not_called()
        fast.assert_called_once()

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
        # Resolver output: the captured gemini_claw resolution (selected carries the guarded entrypoint), plus
        # the three captured matches with an extra private field the hint must drop.
        payload = dict(CAPTURE["resolution_now"]["gemini_claw"])
        captured_hint = CAPTURE["gemini_claw_hint_now"]["hint"]
        payload["matches"] = [{**row, "notes": "hidden"} for row in captured_hint["matches"]] + [
            {"id": "device.assistance", "name": "Device", "score": 0.26}
        ]
        self.assertEqual(payload["selected"]["entrypoint"], "python -m telecom.maxit_guarded_service balance --mode auto")
        completed = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
        with mock.patch.object(mod.subprocess, "run", return_value=completed) as run:
            hint = mod.capability_hint(CAPTURE["gemini_claw_hint_now"]["text"])
        self.assertEqual(hint, captured_hint)
        self.assertEqual(hint["capability"], "telecom.orange.consultation")
        self.assertNotIn("entrypoint", hint["selected"])
        self.assertNotIn("notes", hint["matches"][0])
        argv = run.call_args.args[0]
        self.assertIn("gemini_claw", argv)
        prompt = mod.build_prompt(CAPTURE["gemini_claw_hint_now"]["text"], 42, [], hint)
        self.assertTrue(prompt.count(CAPTURE["gemini_claw_hint_now"]["prompt_hint_prefix"]) == 1)

    def test_prompt_mentions_single_capability_tool_when_hint_present(self):
        prompt = mod.build_prompt(
            "mon solde orange",
            42,
            [],
            {"capability": "telecom.orange.consultation", "selected": {"executor": "claw.skill_route"}},
        )
        self.assertIn("clawmobile_capability", prompt)
        self.assertIn("CAPABILITY_HINT=", prompt)


    def test_provider_fallback_prompt_is_answer_only_without_memory_payload(self):
        prompt = mod.build_provider_fallback_prompt("hello", "trusted", 42)
        self.assertIn("answer-only", prompt)
        self.assertIn("USER=hello", prompt)
        self.assertNotIn("MEMORY=", prompt)
        self.assertNotIn("CAPABILITY_HINT=", prompt)
        self.assertIn("do not call tools", prompt)

    def test_provider_fallback_skips_fast_path_memory_and_capability(self):
        import io
        import subprocess
        completed = subprocess.CompletedProcess([], 0, '{"status":"ok"}', "")
        with tempfile.TemporaryDirectory() as td:
            old_state = mod.STATE
            mod.STATE = Path(td) / "state.json"
            try:
                with mock.patch.object(mod, "ensure_free_policy"),                      mock.patch.object(mod, "ensure_efficiency_policy"),                      mock.patch.object(mod, "fast_path_request") as fast,                      mock.patch.object(mod, "compact_memory") as memory,                      mock.patch.object(mod, "capability_hint") as capability,                      mock.patch.object(mod, "current_memory_revision", return_value=77),                      mock.patch.object(mod, "provider_call", return_value=completed) as provider,                      mock.patch.object(mod, "compact_success", return_value={
                         "status": "ok",
                         "text": "fallback-ok",
                         "provider": "google",
                         "model": mod.MODEL_ID,
                         "rerouted": False,
                         "reported_cost_usd": 0,
                         "provider_attempts": 1,
                     }),                      mock.patch.object(sys, "argv", [
                         "gemini-request.py",
                         "--provider-fallback",
                         "--caller", "trusted",
                         "--session", "acceptance",
                         "hello",
                     ]),                      mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                    rc = mod.main()
                result = json.loads(output.getvalue())
            finally:
                mod.STATE = old_state
        self.assertEqual(rc, 0)
        self.assertEqual(result["provider"], "google")
        fast.assert_not_called()
        memory.assert_not_called()
        capability.assert_not_called()
        args = provider.call_args.args
        self.assertIn("answer-only", args[0])
        self.assertTrue(args[1].startswith(mod.PROVIDER_FALLBACK_SESSION_PREFIX))



if __name__ == "__main__":
    unittest.main()
