#!/usr/bin/env python3
"""Offline public synthesis boundary: fake provider, never S24 credentials/network."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import os
import signal
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("gemini_public", HERE / "gemini-request.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def request():
    return {"version": 1, "query": "Nouveautés publiques ?", "responseLanguage": "fr",
            "sources": [{"id": "s1", "title": "Public", "url": "https://example.org/news",
                         "excerpt": "Le nouveau produit est bleu."}],
            "remainingBudgetMs": 12000, "correlationId": "test_public_01"}


def result():
    return {"version": 1, "outcome": "complete", "model": m.MODEL, "profile": m.PROFILE,
            "claims": [{"id": "c1", "text": "Le nouveau produit est bleu.", "sourceIds": ["s1"],
                        "support": [{"sourceId": "s1", "quote": "Le nouveau produit est bleu."}]}],
            "spokenText": "Le nouveau produit est bleu.",
            "metrics": {"synthesisMs": 10, "providerAttempts": 1, "reportedCostUsd": None}, "error": None}


class PublicSynthesis(unittest.TestCase):
    def test_valid_contract_and_all_languages(self):
        for lang in ("fr", "en", "ar", "aeb", "aeb-Latn"):
            value = request(); value["responseLanguage"] = lang
            self.assertEqual(m.validate_public_input(value), value)
        self.assertEqual(m.validate_public_result(result(), request()), result())

    def test_authority_endpoint_memory_and_model_inputs_are_rejected(self):
        for key in ("caller", "endpoint", "memory", "history", "model", "profile", "tools", "sessionId"):
            value = request(); value[key] = "PRIVATE_CANARY"
            with self.assertRaises(m.PolicyError): m.validate_public_input(value)

    def test_secret_input_does_not_reach_provider(self):
        value = request(); value["query"] = "Bearer " + "testSecretCanary" * 3
        with self.assertRaises(m.PolicyError): m.validate_public_input(value)

    def test_invalid_limits_and_types(self):
        for key, value in (("query", "x"*1001), ("remainingBudgetMs", True), ("remainingBudgetMs", 12001),
                           ("sources", []), ("sources", request()["sources"]*6), ("responseLanguage", "xx"),
                           ("correlationId", "owner@example.org")):
            req = request(); req[key] = value
            with self.assertRaises(m.PolicyError): m.validate_public_input(req)

    def test_unsafe_urls(self):
        for url in ("file:///etc/passwd", "javascript:alert(1)", "http://localhost/test", "http://[::1]",
                    "http://169.254.169.254", "http://192.168.1.2", "https://u:p@example.org", "https://example.org/#x"):
            value = request(); value["sources"][0]["url"] = url
            with self.assertRaises(m.PolicyError, msg=url): m.validate_public_input(value)

    def test_duplicate_sources(self):
        value = request(); value["sources"] *= 2
        with self.assertRaises(m.PolicyError): m.validate_public_input(value)

    def test_unobserved_citation_and_quote_are_refused(self):
        for field, value in (("sourceIds", ["unknown"]), ("support", [{"sourceId": "s1", "quote": "invented"}]),
                              ("support", [])):
            output = result(); output["claims"][0][field] = value
            with self.assertRaises(m.PolicyError): m.validate_public_result(output, request())

    def test_duplicate_claims_and_new_fields_are_refused(self):
        output = result(); output["claims"] *= 2
        with self.assertRaises(m.PolicyError): m.validate_public_result(output, request())
        output = result(); output["claims"][0]["toolCall"] = "read_memory"
        with self.assertRaises(m.PolicyError): m.validate_public_result(output, request())

    def test_oral_rendering_cannot_add_assertions(self):
        output = result(); output["spokenText"] += " Et il coûte 100 euros."
        with self.assertRaises(m.PolicyError): m.validate_public_result(output, request())

    def test_unrelated_claim_with_real_quote_requires_review(self):
        output = result(); output["claims"][0]["text"] = "Le propriétaire doit payer 1000 euros."
        output["spokenText"] = output["claims"][0]["text"]
        with self.assertRaisesRegex(m.PolicyError, "synthesis_review_required"):
            m.validate_public_result(output, request())
        output = result(); output["claims"][0]["text"] = "Selon le site, Samsung lance un produit bleu."
        output["spokenText"] = output["claims"][0]["text"]
        with self.assertRaisesRegex(m.PolicyError, "synthesis_review_required"):
            m.validate_public_result(output, request())

    def test_grounded_written_answer_is_admitted(self):
        """Décision d'Amine 17/10 : réponse rédigée (traduite/paraphrasée) quand elle reste ancrée."""
        req = request()
        req["sources"] = [{"id": "s1", "title": "Tibo on X", "url": "https://x.com/thsottiaux/status/2107676072871600470",
                           "excerpt": "Therefore ... the reset has been processed. Enjoy!", "publishedAt": "2026-10-07"}]
        self.assertEqual(m.validate_public_input(req), req)
        output = result()
        output["claims"] = [
            {"id": "c1", "text": "Aucune source ne confirme un reset le 17 octobre.", "sourceIds": ["s1"],
             "support": [{"sourceId": "s1", "quote": "the reset has been processed"}]},
            {"id": "c2", "text": "Le dernier reset annoncé par Tibo date du 7 octobre.", "sourceIds": ["s1"],
             "support": [{"sourceId": "s1", "quote": "the reset has been processed"}]}]
        output["spokenText"] = " ".join(c["text"] for c in output["claims"])
        self.assertEqual(m.validate_public_result(output, req, today="2026-10-17"), output)
        output["claims"][1]["text"] = "Le dernier reset annoncé par Tibo date du 9 octobre."
        output["spokenText"] = " ".join(c["text"] for c in output["claims"])
        with self.assertRaisesRegex(m.PolicyError, "synthesis_review_required"):
            m.validate_public_result(output, req, today="2026-10-17")
        output["claims"][1]["text"] = "Le dernier reset date du 7 octobre [s1]."
        output["spokenText"] = " ".join(c["text"] for c in output["claims"])
        with self.assertRaisesRegex(m.PolicyError, "synthesis_review_required"):
            m.validate_public_result(output, req, today="2026-10-17")

    def test_model_profile_retry_and_unknown_cost_contract(self):
        for field, value in (("model", "other"), ("profile", "google:paid")):
            output = result(); output[field] = value
            with self.assertRaises(m.PolicyError): m.validate_public_result(output, request())
        output = result(); output["metrics"]["reportedCostUsd"] = 0
        with self.assertRaises(m.PolicyError): m.validate_public_result(output, request())
        output = result(); output["metrics"]["providerAttempts"] = 2
        with self.assertRaises(m.PolicyError): m.validate_public_result(output, request())

    def invoke(self, input_value, provider_result, **kwargs):
        raw = json.dumps(input_value).encode()
        stdin = io.TextIOWrapper(io.BytesIO(raw))
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", new_callable=io.StringIO) as out, \
             mock.patch.object(m, "ensure_free_policy"), mock.patch.object(m, "ensure_efficiency_policy"), \
             mock.patch.object(m, "run_public_provider", return_value=provider_result, **kwargs) as provider, \
             mock.patch.object(m, "compact_memory") as memory, mock.patch.object(m, "fast_path_request") as fast, \
             mock.patch.object(m, "provider_call") as conversation:
            self.assertEqual(m.public_synthesis_main(), 0)
            memory.assert_not_called(); fast.assert_not_called(); conversation.assert_not_called()
            return json.loads(out.getvalue()), provider

    def test_main_uses_stdin_without_memory_fastpath_or_conversation(self):
        output, provider = self.invoke(request(), subprocess.CompletedProcess([], 0, json.dumps(result()), ""))
        self.assertEqual(output["outcome"], "complete")
        provider.assert_called_once()
        self.assertEqual(set(provider.call_args.args[0]), m.PUBLIC_INPUT_KEYS)
        self.assertLessEqual(provider.call_args.args[0]["remainingBudgetMs"], 12000)

    def test_subprocess_uses_closed_stdin_and_reaps_owned_group(self):
        proc = mock.Mock(pid=777, args=["node", "helper"], returncode=0)
        proc.communicate.return_value = ("{}", None)
        with mock.patch.object(m.subprocess, "Popen", return_value=proc) as popen, \
             mock.patch.object(m.os, "killpg") as kill:
            m.run_public_provider(request(), m.time.monotonic() + 1)
        self.assertEqual(popen.call_args.args[0][0], "node")
        self.assertEqual(len(popen.call_args.args[0]), 2)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(json.loads(proc.communicate.call_args.args[0]), request())
        kill.assert_called_once_with(777, m.signal.SIGKILL)
        proc.wait.assert_called_once()

    def test_real_selector_does_not_swallow_sigterm_or_sigint_cancellation(self):
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signum=signum), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                wrapper = root / "gemini-request.py"
                wrapper.write_text((HERE / "gemini-request.py").read_text())
                ready = root / "provider.pid"
                helper = root / "gemini-public-synthesis.mjs"
                helper.write_text("import fs from 'node:fs';let raw='';for await(const c of process.stdin)raw+=c;"
                    "process.on('SIGTERM',()=>{});"
                    f"fs.writeFileSync({json.dumps(str(ready))},String(process.pid));setInterval(()=>{{}},1000);")
                code = "\n".join([
                    "import importlib.util,time,sys",
                    f"s=importlib.util.spec_from_file_location('public_test',{str(wrapper)!r})",
                    "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
                    "try: m.run_public_provider({},time.monotonic()+10)",
                    "except m.PublicSynthesisCancelled: print('cancelled',flush=True)",
                ])
                runner = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True)
                provider_pid = None
                try:
                    until = time.monotonic() + 3
                    while not ready.exists() and time.monotonic() < until and runner.poll() is None:
                        time.sleep(0.01)
                    self.assertTrue(ready.exists(), "offline provider must be reached")
                    provider_pid = int(ready.read_text())
                    started = time.monotonic()
                    runner.send_signal(signum)
                    stdout, stderr = runner.communicate(timeout=1)
                    self.assertEqual(runner.returncode, 0, stderr)
                    self.assertEqual(stdout.strip(), "cancelled")
                    self.assertLess(time.monotonic() - started, 0.8)
                    self.assertFalse(Path(f"/proc/{provider_pid}").exists(), "provider must be reaped, not orphaned")
                finally:
                    if runner.poll() is None:
                        runner.kill(); runner.wait()
                    if provider_pid is not None:
                        try: os.killpg(provider_pid, signal.SIGKILL)
                        except ProcessLookupError: pass

    def test_provider_failure_and_secret_stderr_not_projected(self):
        output, provider = self.invoke(request(), subprocess.CompletedProcess([], 1, "", "PRIVATE_CANARY"))
        self.assertEqual(output["outcome"], "partial")
        self.assertNotIn("PRIVATE_CANARY", json.dumps(output))
        provider.assert_called_once()

    def test_untrusted_error_code_not_projected(self):
        value = m.public_degradation("PRIVATE_CANARY")
        output, _ = self.invoke(request(), subprocess.CompletedProcess([], 0, json.dumps(value), ""))
        self.assertNotIn("PRIVATE_CANARY", json.dumps(output))

    def test_review_required_cause_survives_wrapper(self):
        value = m.public_degradation("synthesis_review_required", attempts=1)
        output, _ = self.invoke(request(), subprocess.CompletedProcess([], 0, json.dumps(value), ""))
        self.assertEqual(output["error"]["code"], "synthesis_review_required")
        self.assertEqual(output["metrics"]["providerAttempts"], 1)
        self.assertEqual(output["claims"], [])

    def test_every_cited_source_needs_its_own_exact_quote(self):
        req = request()
        req["sources"].append({"id": "s2", "title": "Other", "url": "https://example.org/other", "excerpt": "Autre passage sans rapport."})
        output = result()
        output["claims"][0]["sourceIds"].append("s2")
        with self.assertRaisesRegex(m.PolicyError, "unsupported_citation"):
            m.validate_public_result(output, req)
        output["claims"][0]["support"].append({"sourceId": "s2", "quote": "Passage inventé."})
        with self.assertRaisesRegex(m.PolicyError, "unsupported_quote"):
            m.validate_public_result(output, req)

    def test_bad_input_never_launches_provider(self):
        value = request(); value["history"] = "PRIVATE_CANARY"
        output, provider = self.invoke(value, None)
        self.assertEqual(output["outcome"], "partial")
        provider.assert_not_called()


if __name__ == "__main__": unittest.main()
