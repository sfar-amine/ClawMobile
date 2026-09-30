import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SETUP = (ROOT / "claw-slack-purge-setup.sh").read_text()

class SlackPurgeSetupTests(unittest.TestCase):
    def test_default_timeout_has_headroom(self):
        self.assertIn('CLAW_SLACK_PURGE_TIMEOUT_SECONDS:-240', SETUP)
        self.assertNotIn('--timeout-seconds 90', SETUP)

    def test_existing_job_is_reconciled(self):
        self.assertIn('openclaw cron edit "$existing"', SETUP)
        self.assertIn('--timeout-seconds "$PURGE_TIMEOUT_SECONDS"', SETUP)
        self.assertIn('--no-output-timeout-seconds "$PURGE_TIMEOUT_SECONDS"', SETUP)

    def test_timeout_override_is_validated(self):
        self.assertIn('Invalid CLAW_SLACK_PURGE_TIMEOUT_SECONDS', SETUP)
        self.assertIn('"$PURGE_TIMEOUT_SECONDS" -lt 30', SETUP)

if __name__ == "__main__":
    unittest.main()
