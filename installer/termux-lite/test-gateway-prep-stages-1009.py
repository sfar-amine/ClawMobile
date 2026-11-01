#!/usr/bin/env python3
"""gateway-prep-stages on OpenClaw 2026.10.9: npm public modules, existing patch owner, inert resolver owners."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
OWNER = HERE / 'openclaw-compat/whatsapp-network-recovery.py'
MANIFEST = json.loads(OWNER.with_name('gateway-prep-stages.json').read_text())
VERSION = '2026.10.9'
FILES = MANIFEST['packages'][VERSION]['files']
FIXTURES = HERE.parent.parent / 'openclaw-plugin-mobile-ui/fixtures'
FIXTURE = FIXTURES / 'openclaw-2026.10.9-compat'
HARNESS = FIXTURE / 'gateway-prep-stages-harness.cjs'
# npm openclaw@2026.10.9 dist/stage-timing-BUG4Fnsv.mjs has the same bytes as the 2026.9.6 S24 capture.
TRACKER = FIXTURES / 's24-2026-10-26-gateway-prep-stages/stage-timing-BUG4Fnsv.mjs'
TRACKER_1009_SHA256 = '1d8cfb8dd0717d5198b6cd0ee4a821175a92bcab254ce2ae72b73dc77ad11a38'
PINNED_96 = {
    'dist/openclaw-tools-thu-J91q.mjs': '313924b5de456a7eb532e4e1921af14092f15b63aa7cfa63b4bbf9f03ef8eb5a',
    'dist/tools-CvXdkvXK.mjs': 'a31975686eddc6a779865ff896b145b3b41bd7c659ac21761448da6861b0d926',
    'dist/builtin-openclaw-q1hiFm14.mjs': 'e4504516aef56cd293e11369e420148c5ad60c80e60128ed64bfb57fb7239e25',
}


def node_binary(override):
    # Same convention as test-gateway-prep-stages.py: *_BIN is a bin directory, or an executable.
    if not override:
        return 'node'
    candidate = Path(override)
    return str(candidate / 'node') if candidate.is_dir() else str(candidate)


NODE = node_binary(os.environ.get('LOCALCI_NODE26_BIN'))


class GatewayPrepStages1009(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'dist').mkdir()
        (self.root / 'package.json').write_text('{"version":"%s"}' % VERSION)
        for item in FILES:
            raw = gzip.decompress((FIXTURE / (Path(item['path']).name + '.gz')).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item['original'])
            (self.root / item['path']).write_bytes(raw)

    def cli(self, mode):
        return subprocess.run([sys.executable, str(OWNER), '--patch-set', 'gateway-prep-stages',
                               '--openclaw-root', str(self.root), '--' + mode],
                              capture_output=True, text=True, timeout=10)

    def snapshot(self):
        return {item['path']: (self.root / item['path']).read_bytes() for item in FILES}

    def test_variant_applies_atomically_idempotently_and_reverses(self):
        original = self.snapshot()
        self.assertNotEqual(self.cli('check').returncode, 0)
        for mode in ('apply', 'check', 'apply'):
            result = self.cli(mode)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for item in FILES:
            self.assertEqual(hashlib.sha256((self.root / item['path']).read_bytes()).hexdigest(), item['patched'])
        rolled = self.cli('rollback')
        self.assertEqual(rolled.returncode, 0, rolled.stdout)
        self.assertEqual(json.loads(rolled.stdout)['state'], 'rolled_back')
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(json.loads(self.cli('rollback').stdout)['state'], 'unchanged')

    def test_late_unknown_module_and_unknown_version_refuse_before_first_write(self):
        last = self.root / FILES[-1]['path']
        last.write_bytes(last.read_bytes() + b'// authored drift\n')
        original = self.snapshot()
        result = self.cli('apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsupported_module_hash', result.stdout)
        self.assertEqual(self.snapshot(), original)
        (self.root / 'package.json').write_text('{"version":"2026.10.1"}')
        self.assertIn('unsupported_package_version', self.cli('apply').stdout)
        self.assertEqual(self.snapshot(), original)

    def test_2026_9_6_set_is_unchanged(self):
        self.assertEqual(MANIFEST['package_version'], '2026.9.6')
        self.assertEqual({item['path']: item['original'] for item in MANIFEST['files']}, PINNED_96)
        self.assertEqual(set(MANIFEST['packages']), {VERSION})
        # Same plugin-tools checkpoints as the 2026.9.6 set: those two modules did not change around the anchors.
        by_name = {Path(item['path']).name: item['replacements'] for item in MANIFEST['files']}
        self.assertEqual(FILES[0]['replacements'], by_name['openclaw-tools-thu-J91q.mjs'])
        self.assertEqual(FILES[1]['replacements'], by_name['tools-CvXdkvXK.mjs'])

    def test_captured_resolver_and_system_prompt_behavior_and_stage_boundaries(self):
        self.assertEqual(hashlib.sha256(TRACKER.read_bytes()).hexdigest(), TRACKER_1009_SHA256)
        for staged in (False, True):
            if staged:
                applied = self.cli('apply')
                self.assertEqual(applied.returncode, 0, applied.stdout)
            result = subprocess.run([NODE, str(HARNESS), str(self.root), str(TRACKER)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIs(json.loads(result.stdout)['staged'], staged)
        for item in FILES:
            result = subprocess.run([NODE, '--check', str(self.root / item['path'])],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_transient_set_stays_explicit_and_disjoint(self):
        for item in FILES:
            for before, after in item['replacements']:
                added = after.replace(before, '') if before in after else after
                for forbidden in ('console.', 'process.env', 'Date.now', 'setTimeout', 'import('):
                    self.assertNotIn(forbidden, added)
        for name in ('gateway-start.sh', 'runtime-sync.sh', 'companion-deploy.sh'):
            self.assertNotIn('--patch-set gateway-prep-stages', (HERE / name).read_text())
        ours = {item['path'] for item in FILES}
        for path in OWNER.parent.glob('*.json'):
            if path.name != 'gateway-prep-stages.json':
                other = json.loads(path.read_text())
                theirs = [item['path'] for item in (other.get('packages') or {}).get(VERSION, {}).get('files', [])]
                self.assertFalse(ours.intersection(theirs), path.name)


if __name__ == '__main__':
    unittest.main()
