#!/usr/bin/env python3
"""R09: every Termux-lite test is either run by CI or explicitly platform-only."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
TEST_ROOT = ROOT / "installer" / "termux-lite"
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

# These tests validate the real Termux executable tree and login-shell
# behavior. Replacing /data/data/com.termux here would stop testing their
# contract, so they remain in the on-device acceptance rather than Ubuntu CI.
PLATFORM_ONLY = {
    "test-openclaw-login-shell.sh": "requires the real Termux login bash and PREFIX tree",
    "test-termux-tmp-paths.sh": "requires the real Termux PREFIX and tmp-path semantics",
}


class CiRegistrationTests(unittest.TestCase):
    def test_every_test_is_registered_or_justified(self):
        workflow = WORKFLOW.read_text()
        tests = sorted(path.name for path in TEST_ROOT.glob("test-*") if path.is_file())
        missing = [name for name in tests if name not in workflow and name not in PLATFORM_ONLY]
        self.assertEqual(missing, [], "tests absent from ci.yml: " + ", ".join(missing))

    def test_platform_only_exceptions_are_present_and_justified(self):
        for name, reason in PLATFORM_ONLY.items():
            with self.subTest(name=name):
                self.assertTrue((TEST_ROOT / name).is_file())
                self.assertGreaterEqual(len(reason.split()), 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
