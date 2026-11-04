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
        self.assertIn('ensure_supervisor tier0_watchdog',guardian)
        self.assertIn('.openclaw/tier0/bin/tier0-watchdog.py',guardian)

    def test_termux_background_policy_is_reconciled_by_tier0_and_health_manager(self):
        root=Path(__file__).resolve().parent
        bootstrap=(root/'tier0-bootstrap.sh').read_text()
        manager=(root/'samantha-health-manager.sh').read_text()
        self.assertIn('android-network-mutation-guard.py" ensure-termux-background',bootstrap)
        loop=manager.split("while :; do",1)[1]
        self.assertLess(loop.index(' check_adb\n'),loop.index(' check_network_safety\n'))
        self.assertIn('android-network-mutation-guard.py" check',manager)

    def test_health_manager_supervises_termux_sshd_on_canonical_port(self):
        root=Path(__file__).resolve().parent
        manager=(root/'samantha-health-manager.sh').read_text()
        self.assertIn('check_sshd(){',manager)
        self.assertIn('/data/data/com.termux/files/usr/bin/sshd',manager)
        self.assertIn('/dev/tcp/127.0.0.1/8022',manager)
        loop=manager.split("while :; do",1)[1]
        self.assertIn(' check_sshd\n',loop)


    def test_installer_includes_static_native_recovery_entrypoint(self):
        root=Path(__file__).resolve().parent
        text=(root/'install-tier0-control.py').read_text()
        self.assertIn("'native-recovery-entrypoint.py'",text)
        self.assertIn('allow-external-apps=true',text)

    def test_soak_grace_is_declared(self):
        root=Path(__file__).resolve().parent
        self.assertIn('startup_grace_seconds',(root/'tier0-control.py').read_text())
        self.assertIn('soak_grace_until_epoch',(root/'tier0-watchdog.py').read_text())

    def test_remote_desktop_critical_release_extends_startup_grace(self):
        root=Path(__file__).resolve().parent
        text=(root/'tier0-control.py').read_text()
        self.assertIn("if 'remote_desktop' in critical_capabilities:",text)
        self.assertIn('startup_grace_seconds=max(startup_grace_seconds,210)',text)

    def test_tier0_installer_resolves_source_commit_from_nested_source(self):
        root=Path(__file__).resolve().parent
        text=(root/'install-tier0-control.py').read_text()
        self.assertIn("['git','-C',str(source),'rev-parse','HEAD']",text)
        self.assertNotIn('source.parents[2]',text)

    def test_tier0_installer_preserves_or_accepts_critical_capabilities(self):
        root=Path(__file__).resolve().parent
        text=(root/'install-tier0-control.py').read_text()
        self.assertIn("--critical-capability",text)
        self.assertIn("state.get('critical_capabilities'",text)
        self.assertIn("cmd += ['--critical-capability',cap]",text)

    def test_tier0_scripts_exist(self):
        root=Path(__file__).resolve().parent
        for n in ['tier0-control.py','runtime_mode.py','tier0-watchdog.py','tier0-bootstrap.sh','install-tier0-control.py']:self.assertTrue((root/n).is_file(),n)

    def test_tier0_promotion_uses_existing_deployment_lock(self):
        root=Path(__file__).resolve().parent
        control=(root/'tier0-control.py').read_text()
        installer=(root/'install-tier0-control.py').read_text()
        deploy=(root/'companion-deploy.sh').read_text()
        self.assertIn("runtime_mode.deployment_guard() if a.cmd=='promote'",control)
        self.assertIn("'runtime_mode.py'",installer)
        self.assertIn("SAMANTHA_DEPLOY_LOCK_FD=9",deploy)
        self.assertIn("pass_fds=pass_fds",installer)

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

    def _restart_plan(self):
        text=(Path(__file__).resolve().parent/'tier0-bootstrap.sh').read_text()
        source=text[text.index("<<'PY'\n")+7:text.index('\nPY\n)"')]
        namespace={'__name__':'tier0_restart_core_plan'}  # defines the plan only: nothing is listed or signalled
        exec(compile(source,'tier0-bootstrap.sh:restart_core','exec'),namespace)
        def rows(*entries):
            return {pid:{'pid':pid,'ppid':ppid,'start':str(pid),'args':args} for pid,ppid,args in entries}
        return namespace['plan'],rows

    def test_restart_boundary_spares_its_own_chain_when_requested_from_the_supervisor_tree(self):
        # The soak watchdog is started by the bootstrap before it execs the guardian, so its rollback
        # Popen()s `tier0-bootstrap.sh --restart-core` from inside the guardian tree. Killing that shell (or the
        # planner itself) would cancel the relaunch and leave the device with no supervisor.
        plan,rows=self._restart_plan()
        R='/data/data/com.termux/files/home/.openclaw/releases/r1/current'
        table=rows(
            (100,1,f'bash {R}/samantha-root-guardian.sh'),
            (110,100,'python3 /home/.openclaw/tier0/bin/tier0-watchdog.py'),
            (120,110,'bash /home/.openclaw/tier0/bin/tier0-bootstrap.sh --restart-core'),
            (130,120,'python3 -'),
            (200,100,f'bash {R}/samantha-health-manager.sh'),
            (210,200,'node dist/companion/server.js'),
            (300,100,f'bash {R}/incident-orchestrator-worker.sh'),
            (310,300,'sleep 30'),
            (400,1,'node unrelated'),
        )
        order,spared=plan(table,130)
        self.assertEqual(set(order),{100,200,210,300,310})
        self.assertEqual(spared,{110,120})
        self.assertLess(order.index(210),order.index(200))
        self.assertLess(order.index(310),order.index(300))
        self.assertLess(order.index(200),order.index(100))

    def test_restart_boundary_spares_a_deploy_chain_inside_the_tree_but_not_a_supervisor_ancestor(self):
        plan,rows=self._restart_plan()
        table=rows(
            (100,1,'bash /r/samantha-root-guardian.sh'),
            (200,100,'bash /r/samantha-health-manager.sh'),
            (210,200,'node dist/companion/server.js'),
            (220,210,'bash /home/.openclaw/tools/companion-deploy.sh d8e08d9b'),
            (230,220,'python3 /home/.openclaw/tier0/bin/tier0-control.py install'),
            (240,230,'bash -c sleep "$1"; exec "$2" --restart-core'),
            (250,240,'python3 -'),
            (260,220,'curl -fsS http://127.0.0.1:8765/v1/health'),
        )
        order,spared=plan(table,250)
        self.assertEqual(spared,{210,220,230,240})
        self.assertEqual(set(order),{100,200})  # the spared deploy keeps its own helpers (260)

    def test_restart_boundary_outside_the_tree_still_stops_every_supervisor_descendant(self):
        plan,rows=self._restart_plan()
        table=rows(
            (100,1,'bash /r/samantha-root-guardian.sh'),
            (200,100,'bash /r/samantha-health-manager.sh'),
            (210,200,'node dist/companion/server.js'),
            (500,1,'bash -c sleep "$1"; exec "$2" --restart-core'),
            (510,500,'python3 -'),
        )
        order,spared=plan(table,510)
        self.assertEqual(spared,{500})
        self.assertEqual(order,[210,200,100])

    def test_restart_boundary_relaunches_even_when_a_lock_wait_times_out(self):
        text=(Path(__file__).resolve().parent/'tier0-bootstrap.sh').read_text()
        relaunch=text[text.index('wait_for_lock_release "$lock" ||'):text.index('nohup "$0"')]
        self.assertIn('event=restart_core_lock_timeout',relaunch)
        self.assertIn('event=restart_core %s',text)

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
