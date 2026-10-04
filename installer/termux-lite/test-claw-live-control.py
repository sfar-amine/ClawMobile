#!/usr/bin/env python3
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("claw_live_control", Path(__file__).with_name("claw_live_control.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ControlLiveTests(unittest.TestCase):
    def event(self, **kwargs):
        value = dict(tags=["AGENT", "OPENAI"], action="MODEL", detail="password=secret",
                     context="private@example.com", key="otp 123456", metric="4242424242424242", ts=1791049000)
        value.update(kwargs)
        return SimpleNamespace(**value)

    def test_projection_drops_all_untrusted_payload_fields(self):
        row = module.project(self.event(), "test")
        self.assertEqual(row["provider"], "OpenAI")
        self.assertEqual(row["status"], "running")
        for forbidden in ["secret", "private@", "123456", "424242", "password"]:
            self.assertNotIn(forbidden, str(row))
        self.assertEqual(row["source"], "claw-live")

    def test_recovered_is_never_resolved_without_resolution(self):
        self.assertEqual(module.project(self.event(action="RECOVERED"), "1")["status"], "recovered")
        self.assertEqual(module.project(self.event(action="RESOLVED"), "2")["status"], "resolved")

    def test_transport_heartbeat_is_not_business_activity(self):
        self.assertIsNone(module.project(self.event(tags=["LIVE"]), "x"))

    def test_unobserved_provider_is_not_invented(self):
        row = module.project(self.event(tags=["AGENT"], action="INFO"), "1")
        self.assertIsNone(row["provider"])
        self.assertIsNone(row["executor"])

    def test_unknown_action_is_not_healthy(self):
        self.assertEqual(module.project(self.event(action="NEW_STATE"), "x")["status"], "unknown")

    def test_source_identity_is_stable_and_opaque(self):
        one = module.project(self.event(), "source:12")
        two = module.project(self.event(), "source:12")
        self.assertEqual(one["id"], two["id"])
        self.assertNotEqual(one["id"], module.project(self.event(), "source:13")["id"])
        self.assertNotIn("source:12", one["id"])


if __name__ == "__main__":
    unittest.main()
