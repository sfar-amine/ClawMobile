#!/usr/bin/env python3
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "memory_curator_cron", HERE / "reconcile-memory-curator-cron.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def job(description="ancienne description"):
    return {
        "id": "curator-job",
        "declarationKey": MODULE.DECLARATION_KEY,
        "displayName": "Cross-surface Memory Curator",
        "name": "Cross-surface Memory Curator",
        "description": description,
        "enabled": True,
        "schedule": {"kind": "cron", "expr": "10 22 * * *", "tz": "Africa/Tunis"},
        "sessionTarget": "isolated",
        "wakeMode": "now",
        "payload": {"kind": "command", "argv": ["sh", "-lc", "/release/context-dream.sh"]},
        "delivery": {"mode": "none", "channel": "last"},
    }


class CuratorCronTests(unittest.TestCase):
    def fixture(self, jobs):
        handle = tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8")
        json.dump({"jobs": jobs}, handle)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        return Path(handle.name)

    def test_plan_changes_only_stale_description(self):
        result = MODULE.reconcile(self.fixture([job()]), False)
        self.assertEqual(result["state"], "planned")
        self.assertIn("22:10 Africa/Tunis", result["description"])
        self.assertIn("mode shadow", result["description"])
        self.assertIn("M5 non régressive", result["description"])

    def test_current_description_is_idempotent(self):
        result = MODULE.reconcile(self.fixture([job(MODULE.DESCRIPTION)]), False)
        self.assertEqual(result["state"], "unchanged")

    def test_refuses_missing_or_duplicate_owner(self):
        with self.assertRaisesRegex(ValueError, "curator_job_count:0"):
            MODULE.reconcile(self.fixture([]), False)
        with self.assertRaisesRegex(ValueError, "curator_job_count:2"):
            MODULE.reconcile(self.fixture([job(), job()]), False)

    def test_refuses_schedule_command_or_enabled_drift(self):
        changed = job()
        changed["schedule"]["expr"] = "5 13 * * *"
        with self.assertRaisesRegex(ValueError, "curator_schedule_unexpected"):
            MODULE.reconcile(self.fixture([changed]), False)
        changed = job()
        changed["payload"]["argv"][-1] = "/release/other.sh"
        with self.assertRaisesRegex(ValueError, "curator_command_unexpected"):
            MODULE.reconcile(self.fixture([changed]), False)
        changed = job()
        changed["enabled"] = False
        with self.assertRaisesRegex(ValueError, "curator_job_disabled"):
            MODULE.reconcile(self.fixture([changed]), False)

    def test_fixture_cannot_be_applied(self):
        with self.assertRaisesRegex(ValueError, "apply_with_fixture_forbidden"):
            MODULE.reconcile(self.fixture([job()]), True)

    def test_s24_fixture_preserves_shadow_owner_contract(self):
        captured = json.loads(
            (HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-13/r14/memory-curator-cron.json")
            .read_text(encoding="utf-8")
        )
        selected = MODULE.select_curator({"jobs": [captured["job"]]})
        self.assertEqual(selected["schedule"]["expr"], "10 22 * * *")
        self.assertEqual(captured["job"]["lastRun"]["mode"], "shadow")
        self.assertIn("native 13:00 dreaming", selected["description"])

    def test_apply_patches_description_only_and_rechecks_contract(self):
        before = job()
        after = job(MODULE.DESCRIPTION)
        with patch.object(
            MODULE, "load_jobs", side_effect=[{"jobs": [before]}, {"jobs": [after]}]
        ), patch.object(MODULE.subprocess, "run") as run:
            result = MODULE.reconcile(None, True)
        self.assertEqual(result["state"], "updated")
        run.assert_called_once_with(
            [
                "openclaw",
                "cron",
                "edit",
                "curator-job",
                "--description",
                MODULE.DESCRIPTION,
                "--json",
            ],
            check=True,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
