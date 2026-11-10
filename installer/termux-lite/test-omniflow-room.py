"""Non-régression : la room Omniflow n'accorde ni accès owner ni écritures."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class OmniflowRoomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.people = load("omniflow_room_people", "people-trusted.py")
        cls.policy = load("omniflow_room_policy", "project-room.py")

    def test_room_is_explicit_and_conversation_is_implicit(self):
        self.assertEqual(self.people.normalize_rooms(["omniflow"]), ["conversation", "omniflow"])
        self.assertEqual(self.people.room_agent(["conversation", "omniflow"]), "contacts-omniflow")

    def test_combined_room_order_is_canonical(self):
        rooms = self.people.normalize_rooms(["omniflow", "agenda"])
        self.assertEqual(rooms, ["conversation", "agenda", "omniflow"])
        self.assertEqual(self.people.room_agent(rooms), "contacts-agenda-omniflow")

    def test_single_room_tools_are_read_only(self):
        base = {"allow": ["read", "web_search", "samantha_pulse", "samantha_app"],
                "deny": ["exec", "clawmobile_capability"]}
        result = self.policy.room_tool_policy(["omniflow"], base)
        self.assertIn("samantha_omniflow", result["allow"])
        self.assertNotIn("samantha_pulse", result["allow"])
        self.assertNotIn("samantha_app", result["allow"])
        self.assertNotIn("read", result["allow"])
        self.assertNotIn("web_search", result["allow"])
        self.assertIn("exec", result["deny"])
        self.assertIn("clawmobile_capability", result["deny"])


if __name__ == "__main__":
    unittest.main()
