#!/usr/bin/env python3
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("claw_live_control", Path(__file__).with_name("claw_live_control.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
live_spec = importlib.util.spec_from_file_location("claw_live", Path(__file__).with_name("claw-live.py"))
live = importlib.util.module_from_spec(live_spec)
import sys
sys.modules["claw_live"] = live  # dataclasses resolve their module by name
live_spec.loader.exec_module(live)


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

    def test_owner_view_keeps_tags_and_scrubs_secrets(self):
        row = module.project_owner(live, self.event(tags=["openai", "chat"], action="ok", status="done"), "o1")
        self.assertEqual(row["view"], "owner")
        self.assertIn("GPT-CHAT", row["tags"]); self.assertIn("OPENAI", row["tags"])
        self.assertEqual(row["action"], "OK"); self.assertEqual(row["status"], "DONE"); self.assertEqual(row["state"], "healthy")
        for forbidden in ["secret", "123456", "4242424242424242"]:
            self.assertNotIn(forbidden, str(row))

    def test_owner_view_skips_heartbeat_and_bounds_detail(self):
        self.assertIsNone(module.project_owner(live, self.event(tags=["live"]), "o2"))
        row = module.project_owner(live, self.event(detail="x" * 900), "o3")
        self.assertLessEqual(len(row["detail"]), module.OWNER_DETAIL_CHARS)

    def test_unknown_action_is_not_healthy(self):
        self.assertEqual(module.project(self.event(action="NEW_STATE"), "x")["status"], "unknown")

    def test_source_identity_is_stable_and_opaque(self):
        one = module.project(self.event(), "source:12")
        two = module.project(self.event(), "source:12")
        self.assertEqual(one["id"], two["id"])
        self.assertNotEqual(one["id"], module.project(self.event(), "source:13")["id"])
        self.assertNotIn("source:12", one["id"])

    def fake_live(self, rows, fail=False):
        test = self
        class Conn:
            def execute(self, sql, params):
                return SimpleNamespace(fetchall=lambda: list(reversed(rows)))
            def close(self):
                pass
        class Stream:
            def __init__(self, renderer, *_):
                self.renderer = renderer; self.conn = Conn()
            def connect(self):
                if fail:
                    raise OSError("db locked")
                return True
            def handle(self, row):
                self.renderer.emit(test.event(tags=["openai", "chat"], action="OK", detail=row["text"], ts=None))
        return SimpleNamespace(OpenClawStream=Stream, normalize_tags=live.normalize_tags, preview=live.preview)

    def test_owner_backlog_is_oldest_first_with_real_time(self):
        rows = [{"rowid": i, "created_at": 1791049000000 + i * 1000, "text": f"line {i}"} for i in range(1, 6)]
        out = module.owner_backlog(self.fake_live(rows), 3)
        self.assertEqual([r["detail"] for r in out], ["line 3", "line 4", "line 5"])
        self.assertTrue(all(r["replay"] and r["view"] == "owner" for r in out))
        self.assertLess(out[0]["at"], out[-1]["at"])
        again = module.owner_backlog(self.fake_live(rows), 3)
        self.assertEqual([r["id"] for r in out], [r["id"] for r in again])

    def test_owner_backlog_never_breaks_the_stream(self):
        self.assertEqual(module.owner_backlog(self.fake_live([], fail=True), 10), [])
        self.assertEqual(module.owner_backlog(self.fake_live([{"rowid": 1, "created_at": 1, "text": "x"}]), 0), [])


if __name__ == "__main__":
    unittest.main()
