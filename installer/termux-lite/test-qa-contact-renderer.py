#!/usr/bin/env python3
"""Five real private Playbooks CLI -> versioned Core display contracts.

The explicit peer supplies real domain-owner/FIFO frames with synthetic external
authority and transport. Neither producer nor renderer is mocked or copied.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ContactRenderer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        peer = Path(sys.argv[1]).resolve()
        producer = peer / "tests/qa_contact_renderer_fixture.py"
        if not producer.is_file():
            raise AssertionError("Explicit Playbooks peer lacks the versioned producer")
        # Output is a synthetic test artefact, never contact input or a live RPC.
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
            proc = subprocess.run([sys.executable, str(producer)], cwd=peer,
                                  stdout=output, stderr=error, timeout=30)
            if proc.returncode:
                raise AssertionError("Real private CLI fixture failed (exit %s)" % proc.returncode)
            if output.tell() > 1024 * 1024:
                raise AssertionError("Fixture output exceeds one MiB")
            output.seek(0)
            cls.document = json.load(output)
        if cls.document.get("schema_version") != 1:
            raise AssertionError("Unsupported producer contract")
        cases = cls.document["cases"]
        if [case["id"] for case in cases] != ["q1", "q12", "q2", "queue", "report"]:
            raise AssertionError("Expected all five real owner flows")
        cls.cases = {case["id"]: case for case in cases}
        spec = importlib.util.spec_from_file_location(
            "qa_contact_actual_fast_path", Path(__file__).with_name("model-fast-path.py"))
        cls.renderer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.renderer)

    def render(self, payload):
        self.assertIsInstance(payload.get("text"), str)
        normalized = " ".join(payload["text"].split())
        for card in (True, False):
            actual = self.renderer._display_text(payload, card=card)
            # A masked/ignored private text must not silently fall back to a DTO dump.
            self.assertEqual(actual, normalized, "The real display owner rejected the human answer")
            self.assertNotIn(self.document["sensitive_sentinel"], actual)
            self.assertNotRegex(actual, r"qa-contact-|qa-dossier|org\.example\.|Q1-[a-f0-9]+|[a-f0-9]{24,}|/tmp/|dataset[-_]|run_id|plan_version|capability_id|question_id|sha256|fingerprint|\{[\s\S]*\}")
            self.assertGreater(len(actual), 15)
            self.assertLessEqual(len(actual), 4000)
        return normalized.casefold()

    def test_q1_numbered_choices_survive_actual_card_and_plain_renderers(self):
        text = self.render(self.cases["q1"]["payload"])
        for choice in ("1. smoke test", "2. test cadré", "3. non-régression"):
            self.assertIn(choice, text)

    def test_q12_smoke_observation_and_long_build_do_not_drop_confirmation(self):
        payloads = self.cases["q12"]["payloads"]
        self.assertEqual(len(payloads), 3)
        observe, version, protected = [self.render(payload) for payload in payloads]
        self.assertIn("observer", observe)
        self.assertIn("version", observe)
        self.assertIsNone(payloads[0]["result"]["next_question"], "Exercise smoke's separate Q12 owner")
        self.assertIn("2.4", version)
        self.assertIn("oui", version)
        self.assertIn("non", version)
        self.assertEqual(payloads[1]["result"]["app_observation"]["app_build"], "12345678")
        self.assertIn("masqué", protected)
        self.assertIn("dossier", protected)
        self.assertNotIn("12345678", version + protected)

    def test_q2_dossier_validation_is_distinct_from_start(self):
        text = self.render(self.cases["q2"]["payload"])
        self.assertIn("3 cas", text)
        self.assertIn("valider", text)
        self.assertIn("séparément", text)
        validated = self.render(self.cases["q2"]["validated"])
        self.assertIn("validé", validated)
        self.assertIn("démarrer", validated)

    def test_queue_wait_is_not_reported_as_execution(self):
        payload = self.cases["queue"]["payload"]
        self.assertEqual(payload["result"]["queue"]["status"], "WAITING")
        text = self.render(payload)
        self.assertIn("file d’attente", text)
        self.assertIn("disponible", text)
        self.assertNotIn("a démarré", text)

    def test_report_transport_acceptance_does_not_claim_read_receipt(self):
        payload = self.cases["report"]["payload"]
        self.assertEqual(payload["result"]["delivery"]["state"], "ACCEPTED")
        text = self.render(payload)
        self.assertIn("transport", text)
        self.assertIn("accepté", text)
        self.assertIn("rapport", text)
        self.assertNotRegex(text, r"\blu\b|\blue\b|\breçu par toi\b")
        refused = self.cases["report"]["refused"]
        self.assertEqual(refused["result"]["delivery"]["state"], "NOT_SENT")
        self.assertEqual(refused["result"]["delivery"]["reason"], "qa_delivery_capacity_reached")
        cause = self.render(refused)
        self.assertIn("capacité", cause)
        self.assertIn("atteinte", cause)
        self.assertNotIn("accepté", cause)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: test-qa-contact-renderer.py EXPLICIT_PLAYBOOKS_ROOT")
    unittest.main(argv=[sys.argv[0]], verbosity=2)
