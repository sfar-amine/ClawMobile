#!/usr/bin/env python3
"""Q12: real OS locks, fixture-only deploy; no phone, network, build or process stop."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parents[1] / 'openclaw-plugin-mobile-ui/fixtures/qa/deployment-lock-s24-20261018.json'


class CampaignDeployProtection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / 'home'
        self.state = self.home / '.openclaw/deploys'
        self.state.mkdir(parents=True)
        self.repo = self.base / 'repo'
        self.root = self.repo / 'installer/termux-lite'
        self.root.mkdir(parents=True)
        (self.repo / '.git').mkdir()
        shutil.copy2(HERE / 'companion-deploy.sh', self.root / 'companion-deploy.sh')
        (self.root / 'bounded-log.py').write_text('# fixture: no logs\n')
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.marker = self.base / 'forbidden-effects'
        for name in ('git', 'pkill', 'curl', 'npm', 'node'):
            self.stub(name, 'echo ' + name + ' >> "$QA_TEST_EFFECTS"\nexit 99\n')
        # Always stop at the existing memory/battery preflight if admitted.
        self.mem = self.base / 'meminfo'
        self.mem.write_text('MemAvailable: 1024 kB\n')
        self.battery = self.base / 'battery'
        self.battery.write_text('Discharging\n')
        self.stub('uptime', 'echo "load average: 0.00"\n')
        self.stub('git', '[ \"$#\" = 4 ] && [ \"$1\" = -C ] && [ \"$2\" = \"$QA_TEST_REPO\" ] && [ \"$3\" = rev-parse ] && [ \"$4\" = HEAD ] && exit 0\necho git >> \"$QA_TEST_EFFECTS\"\nexit 99\n')
        self.env = dict(os.environ, HOME=str(self.home), CLAW_RUNTIME_ROOT=str(self.root),
                        PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        COMPANION_DEPLOY_LOCK_WAIT_S='0', COMPANION_DEPLOY_WAIT_CALM_S='0',
                        COMPANION_DEPLOY_MEMINFO_FILE=str(self.mem),
                        COMPANION_DEPLOY_BATTERY_STATUS_FILE=str(self.battery),
                        QA_TEST_EFFECTS=str(self.marker), QA_TEST_REPO=str(self.repo))
        self.lock = open(self.state / 'companion-deploy.lock', 'w')
        self.addCleanup(self.lock.close)

    def stub(self, name, body):
        p = self.bin / name
        p.write_text('#!/bin/sh\n' + body)
        p.chmod(0o700)

    def start(self, **overrides):
        return subprocess.Popen(['bash', str(self.root / 'companion-deploy.sh'), 'a' * 40],
                                env=dict(self.env, **overrides), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)

    def check_no_effect(self):
        self.assertFalse(self.marker.exists(), self.marker.read_text() if self.marker.exists() else '')

    def test_real_capture_confirms_shared_lock_contract(self):
        data = json.loads(FIXTURE.read_text())
        self.assertTrue(data['lock_exists'])
        self.assertTrue(data['flock_shared_documented'])
        self.assertEqual(data['lock_relative'], '.openclaw/deploys/companion-deploy.lock')
        source = (HERE / 'companion-deploy.sh').read_text()
        self.assertIn('exec 9>"$STATE/companion-deploy.lock"', source)
        self.assertFalse(any('flock -w' in line for line in source.splitlines() if not line.lstrip().startswith('#')))

    def test_shared_campaign_refuses_without_dispatching_deployment(self):
        fcntl.flock(self.lock, fcntl.LOCK_SH)
        process = self.start()
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 3, stderr)
        self.assertIn('deploy_lock_busy', stderr)
        self.assertEqual(stdout, '')
        self.assertEqual(list(self.state.glob('companion-*.json')), [])
        self.check_no_effect()

    def test_another_deployment_is_also_preserved(self):
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        process = self.start()
        _, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 3)
        self.assertIn('deploy_already_running', stderr)
        self.check_no_effect()

    def test_waits_until_campaign_cleanup_releases_shared_lock(self):
        fcntl.flock(self.lock, fcntl.LOCK_SH)
        process = self.start(COMPANION_DEPLOY_LOCK_WAIT_S='2')
        time.sleep(0.3)
        self.assertIsNone(process.poll())
        self.check_no_effect()
        self.assertEqual(list(self.state.glob('companion-*.json')), [])
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stderr)
        receipt = json.loads(Path(stdout.strip()).read_text())
        self.assertEqual(receipt['state'], 'deferred')
        self.assertIn('preflight', receipt['detail'])
        self.check_no_effect()

    def test_wait_budget_expires_without_fetch_or_retry_later(self):
        fcntl.flock(self.lock, fcntl.LOCK_SH)
        process = self.start(COMPANION_DEPLOY_LOCK_WAIT_S='1')
        _, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 3)
        self.assertIn('wait_budget=1s', stderr)
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.assertEqual(list(self.state.glob('companion-*.json')), [])
        self.check_no_effect()

    def test_deadline_includes_slow_flock_commands(self):
        real_flock = shutil.which('flock')
        self.stub('flock', 'sleep 0.25\nexec "' + real_flock + '" "$@"\n')
        fcntl.flock(self.lock, fcntl.LOCK_SH)
        process = self.start(COMPANION_DEPLOY_LOCK_WAIT_S='1')
        _, stderr = process.communicate(timeout=3)
        self.assertEqual(process.returncode, 3, stderr)
        self.assertIn('deploy_lock_busy', stderr)
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.assertEqual(list(self.state.glob('companion-*.json')), [])
        self.check_no_effect()

    def test_two_campaign_holders_keep_deployment_blocked(self):
        second = open(self.lock.name, 'r')
        self.addCleanup(second.close)
        fcntl.flock(self.lock, fcntl.LOCK_SH)
        fcntl.flock(second, fcntl.LOCK_SH)
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        process = self.start()
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 3)
        self.check_no_effect()

    def test_invalid_budgets_fail_closed_before_any_effect(self):
        for value in ('', '-1', '601', '999999999999999999999', '1.5', '01', '1;exit', ' 1'):
            with self.subTest(value=value):
                process = self.start(COMPANION_DEPLOY_LOCK_WAIT_S=value)
                _, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 2, stderr)
                self.assertIn('deploy_lock_wait_invalid', stderr)
                self.check_no_effect()

    def test_flock_error_fails_closed_instead_of_reaching_preflight(self):
        self.stub('flock', 'exit 2\n')
        process = self.start(COMPANION_DEPLOY_LOCK_WAIT_S='600')
        _, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 3)
        self.assertIn('deploy_lock_unavailable', stderr)
        self.check_no_effect()


if __name__ == '__main__':
    unittest.main()
