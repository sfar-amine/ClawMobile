#!/data/data/com.termux/files/usr/bin/python3
import subprocess
import tempfile
import unittest
from pathlib import Path

class Tier0Tests(unittest.TestCase):
    def test_source_scripts_have_runtime_root_override(self):
        root=Path(__file__).resolve().parent
        names=['samantha-bootstrap.sh','samantha-root-guardian.sh','samantha-health-manager.sh','incident-orchestrator-worker.sh']
        for n in names:self.assertIn('CLAW_RUNTIME_ROOT',(root/n).read_text(),n)

    def test_bootstrap_and_guardian_enforce_canonical_runtime(self):
        root=Path(__file__).resolve().parent
        bootstrap=(root/'samantha-bootstrap.sh').read_text()
        guardian=(root/'samantha-root-guardian.sh').read_text()
        self.assertIn('tier0-control.py',bootstrap)
        self.assertIn('process_uses_script',bootstrap)
        self.assertIn('tier0-control.py',guardian)
        self.assertIn('runtime_drift',guardian)
        self.assertIn('process_uses_script',guardian)

    def test_termux_background_policy_is_reconciled_by_tier0_and_health_manager(self):
        root=Path(__file__).resolve().parent
        bootstrap=(root/'tier0-bootstrap.sh').read_text()
        manager=(root/'samantha-health-manager.sh').read_text()
        self.assertIn('android-network-mutation-guard.py" ensure-termux-background',bootstrap)
        loop=manager.split("while :; do",1)[1]
        self.assertLess(loop.index(' check_adb\n'),loop.index(' check_network_safety\n'))
        self.assertIn('android-network-mutation-guard.py" check',manager)

    def test_soak_grace_is_declared(self):
        root=Path(__file__).resolve().parent
        self.assertIn('startup_grace_seconds',(root/'tier0-control.py').read_text())
        self.assertIn('soak_grace_until_epoch',(root/'tier0-watchdog.py').read_text())

    def test_tier0_scripts_exist(self):
        root=Path(__file__).resolve().parent
        for n in ['tier0-control.py','tier0-watchdog.py','tier0-bootstrap.sh','install-tier0-control.py']:self.assertTrue((root/n).is_file(),n)

    def test_core_identity_checks_do_not_spawn_lock_inheriting_pipelines(self):
        root=Path(__file__).resolve().parent
        for name in ['samantha-root-guardian.sh','samantha-health-manager.sh']:
            text=(root/name).read_text()
            self.assertIn("read -r -d '' arg",text,name)
            self.assertNotIn('| grep -Fx -- "$script"',text,name)

    def test_restart_boundary_captures_core_descendants_before_termination(self):
        root=Path(__file__).resolve().parent
        text=(root/'tier0-bootstrap.sh').read_text()
        self.assertIn("targets=set(roots)",text)
        self.assertIn("r['ppid'] in targets",text)
        self.assertIn("identities={pid:rows[pid]['start']",text)
        self.assertIn("Children first",text)

    def test_core_supervisor_long_lived_children_close_lock_fd(self):
        root=Path(__file__).resolve().parent
        guardian=(root/'samantha-root-guardian.sh').read_text()
        manager=(root/'samantha-health-manager.sh').read_text()
        self.assertIn('pgrep -f "$1" 9>&-',guardian)
        self.assertIn('pgrep -f "$pat" 9>&-',guardian)
        self.assertIn('pgrep -f "$1" 9>&-',manager)
        self.assertIn('pgrep -f "$pat" 9>&-',manager)
        self.assertIn('health-verdict.py" --write 9>&-',manager)
        self.assertIn('incident-ingress.py" 9>&-',manager)
        self.assertIn('incident-reconcile.sh" 9>&-',manager)

    def test_restart_lock_wait_uses_toybox_fd_contract(self):
        root=Path(__file__).resolve().parent
        text=(root/'tier0-bootstrap.sh').read_text()
        self.assertNotIn('flock -n "$lock" true',text)
        self.assertIn('flock -n 8',text)
        with tempfile.NamedTemporaryFile() as lock:
            run=subprocess.run(
                ['bash','-lc',f'exec 8>"{lock.name}"; flock -n 8; flock -u 8'],
                capture_output=True,
                text=True,
                timeout=5,
            )
        self.assertEqual(run.returncode,0,run.stderr)

if __name__=='__main__':unittest.main()
