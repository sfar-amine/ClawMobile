#!/usr/bin/env python3
"""Pinned S24 public SDK fixture, existing patch transaction, inert resolver owners."""
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
FIXTURE = HERE.parent.parent / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-26-gateway-prep-stages'
def node_binary(override):
    # localci.py owns setup-node and documents *_BIN as a bin DIRECTORY.
    # Keep direct executable support for standalone targeted checks only.
    if not override:
        return 'node'
    candidate = Path(override)
    return str(candidate / 'node') if candidate.is_dir() else str(candidate)


NODE = node_binary(os.environ.get('LOCALCI_NODE26_BIN'))


class GatewayPrepStages(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'dist').mkdir()
        (self.root / 'package.json').write_text('{"version":"2026.9.6"}')
        for item in MANIFEST['files']:
            raw = gzip.decompress((FIXTURE / (Path(item['path']).name + '.gz')).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item['original'])
            (self.root / item['path']).write_bytes(raw)

    def cli(self, mode):
        return subprocess.run([sys.executable, str(OWNER), '--patch-set', 'gateway-prep-stages',
                               '--openclaw-root', str(self.root), '--' + mode],
                              capture_output=True, text=True, timeout=5)

    def snapshot(self):
        return {item['path']: (self.root / item['path']).read_bytes() for item in MANIFEST['files']}

    def test_full_pinned_modules_atomic_idempotent_and_reversible(self):
        original = self.snapshot()
        self.assertNotEqual(self.cli('check').returncode, 0)
        for mode in ('apply', 'check', 'apply'):
            result = self.cli(mode)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for item in MANIFEST['files']:
            self.assertEqual(hashlib.sha256((self.root / item['path']).read_bytes()).hexdigest(), item['patched'])
        self.assertEqual(self.cli('rollback').returncode, 0)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.cli('rollback').returncode, 0)

    def test_late_unknown_module_refuses_before_first_write(self):
        last = self.root / MANIFEST['files'][-1]['path']
        last.write_bytes(last.read_bytes() + b'// authored drift\n')
        original = self.snapshot()
        result = self.cli('apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsupported_module_hash', result.stdout)
        self.assertEqual(self.snapshot(), original)

    def test_wrong_package_and_symlink_refuse(self):
        original = self.snapshot()
        (self.root / 'package.json').write_text('{"version":"2026.10.1"}')
        self.assertIn('unsupported_package_version', self.cli('apply').stdout)
        self.assertEqual(self.snapshot(), original)
        (self.root / 'package.json').write_text('{"version":"2026.9.6"}')
        last = self.root / MANIFEST['files'][-1]['path']
        real = last.with_suffix('.original')
        last.rename(real)
        last.symlink_to(real)
        self.assertIn('patch_module_path_invalid', self.cli('apply').stdout)
        self.assertEqual(self.snapshot(), original)

    def test_captured_resolver_behavior_and_stage_boundaries(self):
        for staged in (False, True):
            if staged:
                applied = self.cli('apply')
                self.assertEqual(applied.returncode, 0, applied.stdout)
            result = subprocess.run([NODE, str(HERE / 'test-gateway-prep-stages.cjs'), str(self.root)],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIs(json.loads(result.stdout)['staged'], staged)
        for item in MANIFEST['files']:
            result = subprocess.run([NODE, '--check', str(self.root / item['path'])],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_canonical_bin_directory_and_targeted_executable_invoke_same_node(self):
        selected = Path(shutil.which(NODE) or NODE).resolve(strict=True)
        self.assertTrue(selected.is_file())
        versions = []
        for override in (str(selected.parent), str(selected)):
            executable = node_binary(override)
            self.assertTrue(Path(executable).samefile(selected))
            result = subprocess.run([executable, '--version'], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertRegex(result.stdout.strip(), r'^v26\.[0-9]+\.[0-9]+$')
            versions.append(result.stdout)
        self.assertEqual(versions[0], versions[1])

    def test_transient_set_does_not_enable_other_patch_sets_or_product_switches(self):
        for item in MANIFEST['files']:
            self.assertIn(Path(item['path']).name, ('openclaw-tools-thu-J91q.mjs', 'tools-CvXdkvXK.mjs',
                                                  'builtin-openclaw-q1hiFm14.mjs'))
            for before, after in item['replacements']:
                added = after.replace(before, '') if before in after else after
                self.assertNotIn('console.', added)
                self.assertNotIn('process.env', added)
                self.assertNotIn('Date.now', added)
                self.assertNotIn('setTimeout', added)
        for name in ('gateway-start.sh', 'runtime-sync.sh', 'companion-deploy.sh'):
            self.assertNotIn('--patch-set gateway-prep-stages', (HERE / name).read_text())
        ours = {item['path'] for item in MANIFEST['files']}
        for path in OWNER.parent.glob('*.json'):
            if path.name != 'gateway-prep-stages.json':
                other = json.loads(path.read_text())
                self.assertFalse(ours.intersection(item['path'] for item in other.get('files', [])))
        provenance = json.loads((FIXTURE / 'provenance.json').read_text())
        tracker = (FIXTURE / 'stage-timing-BUG4Fnsv.mjs').read_bytes()
        self.assertEqual(hashlib.sha256(tracker).hexdigest(), provenance['trackerPublicSourceSha256'])
        timings = json.loads((FIXTURE / 'native-timings.json').read_text())
        self.assertEqual(timings['factorySummary']['totalMs'], 16)
        self.assertFalse(timings['L0bisClosed'])


if __name__ == '__main__':
    unittest.main()
