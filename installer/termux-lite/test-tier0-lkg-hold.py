#!/usr/bin/env python3
"""Doc 51 I3: a release that passes the soak is not last-known-good until it held LKG_HOLD_S clean seconds."""
import fcntl, importlib.util, json, os, sys, tempfile, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class LkgHold(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.home = Path(self.tmp.name)
        self.old_home = os.environ.get('HOME'); os.environ['HOME'] = str(self.home); os.environ['TIER0_LKG_HOLD_S'] = '3600'
        rel = self.home / '.openclaw/releases'
        for name in ('A', 'B'): (rel / name).mkdir(parents=True)
        (rel / 'current').symlink_to(rel / 'B'); (rel / 'last-known-good').symlink_to(rel / 'A')
        (self.home / '.openclaw/tier0').mkdir(parents=True); (self.home / '.openclaw/health').mkdir(parents=True)
        (self.home / '.openclaw/deploys').mkdir(parents=True)
        spec = importlib.util.spec_from_file_location('tier0_watchdog', HERE / 'tier0-watchdog.py')
        self.w = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.w)
        self.health(True)
        self.state({'soak_state': 'running', 'soak_deadline_epoch': int(time.time()) - 1, 'soak_grace_until_epoch': 0,
                    'critical_capabilities': ['immune.health_manager', 'gateway', 'companion'], 'current': 'B', 'last_known_good': 'A'})

    def tearDown(self):
        if self.old_home is None: os.environ.pop('HOME', None)
        else: os.environ['HOME'] = self.old_home
        os.environ.pop('TIER0_LKG_HOLD_S', None); self.tmp.cleanup()

    def health(self, ok, cap='gateway', generated_at=None):
        caps = {c: {'state': 'healthy'} for c in ('immune.health_manager', 'gateway', 'companion')}
        if not ok: caps[cap] = {'state': 'degraded'}
        value = {'capabilities': caps, 'generated_at': time.time()}
        if generated_at is not None: value['generated_at'] = generated_at
        (self.home / '.openclaw/health/current.json').write_text(json.dumps(value))

    def test_health_sample_older_than_the_grace_is_not_evidence(self):
        # S24 16/10: rollback of 20261016T112943 on a Gateway shutdown sample generated before the grace ended.
        now = int(time.time())
        s = self.state(); s.update(soak_deadline_epoch=now + 600, soak_grace_until_epoch=now - 5, soak_bad_samples=0); self.state(s)
        self.health(False, 'gateway', generated_at=now - 60)
        for _ in range(3): self.w.tick()
        s = self.state(); self.assertEqual('running', s['soak_state']); self.assertEqual(0, s['soak_bad_samples'])
        self.assertEqual('A', self.lkg())
        self.health(False, 'gateway', generated_at=now)
        self.w.tick(); self.assertEqual(1, self.state()['soak_bad_samples'], 'a fresh sample still counts')

    def test_stale_health_never_makes_a_release_stable(self):
        now = int(time.time())
        s = self.state(); s.update(soak_deadline_epoch=now - 1, soak_grace_until_epoch=now - 5); self.state(s)
        self.health(True, generated_at=now - 60); self.w.tick()
        self.assertEqual('running', self.state()['soak_state'])
        self.health(True, generated_at=now); self.w.tick()
        self.assertEqual('stable', self.state()['soak_state'])

    def state(self, value=None):
        p = self.home / '.openclaw/tier0/state.json'
        if value is not None: p.write_text(json.dumps(value))
        return json.loads(p.read_text())

    def lkg(self): return (self.home / '.openclaw/releases/last-known-good').resolve().name

    def test_soak_success_keeps_previous_lkg_until_hold_passes(self):
        self.w.tick(); s = self.state()
        self.assertEqual('stable', s['soak_state']); self.assertEqual('B', s['lkg_candidate']); self.assertEqual('A', self.lkg())
        self.w.tick(); self.assertEqual('A', self.lkg(), 'hold not elapsed')
        s['lkg_due_epoch'] = int(time.time()) - 1; self.state(s); self.w.tick()
        self.assertEqual('B', self.lkg()); self.assertNotIn('lkg_candidate', self.state())

    def test_bad_sample_during_hold_restarts_the_clean_window(self):
        self.w.tick(); s = self.state(); s['lkg_due_epoch'] = int(time.time()) - 1; self.state(s)
        self.health(False, 'companion'); self.w.tick()
        self.assertEqual('A', self.lkg()); self.assertGreater(self.state()['lkg_due_epoch'], int(time.time()) + 3000)

    def test_newer_promotion_drops_the_candidate(self):
        self.w.tick()
        cur = self.home / '.openclaw/releases/current'; cur.unlink(); cur.symlink_to(self.home / '.openclaw/releases/A')
        self.w.tick(); self.assertNotIn('lkg_candidate', self.state()); self.assertEqual('A', self.lkg())

    def test_samples_during_a_companion_deploy_are_not_evidence(self):
        s = self.state(); s['soak_deadline_epoch'] = int(time.time()) + 600; s['soak_bad_samples'] = 1; self.state(s)
        self.health(False, 'companion')
        with (self.home / '.openclaw/deploys/companion-deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.w.tick()
        s = self.state(); self.assertEqual(0, s['soak_bad_samples']); self.assertEqual('running', s['soak_state'])

    def test_default_soak_watches_user_facing_capabilities(self):
        text = (HERE / 'tier0-control.py').read_text()
        for cap in ("'gateway'", "'companion'", "'transactions.runtime'"): self.assertIn(cap, text)
        self.assertIn("s.get('lkg_candidate')==old.name", text, 'promote keeps the confirmed LKG')



class RepairHandlerGate(unittest.TestCase):
    """Doc 51 I2: no model diagnosis for a component nobody can repair; one list for the worker and the health manager."""
    def run_handled(self, *args):
        import subprocess
        return subprocess.run([sys.executable, str(HERE / 'incident-orchestrator.py'), 'handled', *args], capture_output=True).returncode

    def test_direct_handlers_and_unknown_components(self):
        self.assertEqual(0, self.run_handled('--direct', 'adb'))
        self.assertEqual(0, self.run_handled('--direct', 'remote_desktop'))
        self.assertEqual(1, self.run_handled('--direct', 'whatsapp'))
        self.assertEqual(1, self.run_handled('--direct', 'companion'))

    def test_health_manager_and_worker_use_the_same_gate(self):
        hm = (HERE / 'samantha-health-manager.sh').read_text(); worker = (HERE / 'incident-orchestrator-worker.sh').read_text()
        self.assertIn('incident-orchestrator.py" handled "$n"', hm)
        self.assertIn('state=awaiting_deterministic_recovery reason=no_repair_handler', hm)
        self.assertIn('incident-orchestrator.py" handled --direct "$component"', worker)
        self.assertIn('state=awaiting_deterministic_recovery reason=no_managed_handler', worker)
        self.assertNotIn('adb|gateway-secretref-exec|openclaw-agent-headless|remote_desktop) ;;', worker)

    def test_ingress_uses_its_own_release_root(self):
        self.assertIn('ROOT = Path(__file__).resolve().parent', (HERE / 'incident-ingress.py').read_text())

if __name__ == '__main__':
    unittest.main()
