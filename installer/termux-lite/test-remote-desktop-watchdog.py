#!/data/data/com.termux/files/usr/bin/python3
import unittest
from pathlib import Path

ROOT=Path(__file__).parent
WD=(ROOT/"remote-desktop-watchdog.sh").read_text()
WK=(ROOT/"incident-orchestrator-worker.sh").read_text()

class RemoteDesktopHardeningTests(unittest.TestCase):
    def test_watchdog_moves_to_stable_cwd(self):
        self.assertIn('cd "$HOME_DIR" || exit 70', WD)
        self.assertLess(WD.index('cd "$HOME_DIR" || exit 70'), WD.index('while :; do'))
        self.assertIn('cd "$HOME_DIR" || return 1', WD)

    def test_watchdog_opens_circuit_after_bounded_restart(self):
        self.assertIn('SELF-HEAL FAILED circuit=open', WD)
        self.assertIn('open_incident "Remote Desktop Commander unavailable after $MAX_RESTARTS bounded deterministic restart attempts"', WD)
        self.assertIn('if [ "$prev" = down ]; then\n     sleep "$INTERVAL"', WD)

    def test_watchdog_uses_canonical_incident_orchestrator(self):
        self.assertIn('open remote_desktop runtime --source remote-desktop-watchdog', WD)
        self.assertIn('recover remote_desktop runtime --source remote-desktop-watchdog', WD)

    def test_process_log_is_bounded(self):
        self.assertIn('-gt 4194304', WD)
        self.assertIn('tail -c 1048576', WD)

    def test_remote_desktop_is_managed_by_orchestrator(self):
        self.assertIn('openclaw-agent-headless|remote_desktop', WK)
        self.assertIn('runtime.managed_repair|diagnostics.collect_more', WK)
        self.assertIn('handler=remote_desktop_stable_cwd', WK)

    def test_model_diagnosis_failures_are_bounded(self):
        self.assertIn('MAX_DIAG_FAILURES="${INCIDENT_MAX_DIAG_FAILURES:-2}"', WK)
        self.assertIn('bounded model diagnosis budget exhausted', WK)

if __name__=="__main__":
    unittest.main(verbosity=2)
