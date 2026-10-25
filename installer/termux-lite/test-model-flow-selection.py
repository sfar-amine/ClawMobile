#!/usr/bin/env python3
"""All pinned modules/types from the actual S24 SDK; no model request or device write."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
FIXTURE = ROOT / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-25-model-flow-sdk'
MANIFEST = HERE / 'openclaw-compat/model-flow-selection.json'
spec = importlib.util.spec_from_file_location('patch_owner', HERE / 'openclaw-compat/whatsapp-network-recovery.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)

class ModelFlowPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.package = Path(self.temp.name) / 'openclaw'
        self.dist = self.package / 'dist'
        self.dist.mkdir(parents=True)
        (self.package / 'package.json').write_text('{"version":"2026.9.6"}')
        self.entries = json.loads(MANIFEST.read_text())['files']
        for entry in self.entries:
            fixture = FIXTURE / Path(entry['path']).name
            raw = fixture.read_bytes() if fixture.exists() else gzip.decompress(fixture.with_suffix(fixture.suffix + '.gz').read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), entry['original'])
            (self.package / entry['path']).write_bytes(raw)
        self.roots = {'openclaw': self.package}

    def snapshot(self):
        return {entry['path']: (self.package / entry['path']).read_bytes() for entry in self.entries}

    def test_full_apply_idempotence_partial_and_exact_rollback(self):
        before = self.snapshot()
        self.assertFalse(owner.reconcile(self.roots, 'check', MANIFEST)['ok'])
        first = self.entries[0]
        path = self.package / first['path']
        path.write_bytes(owner.transform(path.read_bytes(), first))
        result = owner.reconcile(self.roots, 'apply', MANIFEST)
        self.assertEqual(result['changed'], len(self.entries) - 1)
        self.assertTrue(owner.reconcile(self.roots, 'check', MANIFEST)['ok'])
        self.assertEqual(owner.reconcile(self.roots, 'apply', MANIFEST)['changed'], 0)
        for entry in self.entries:
            if entry['path'].endswith('.mjs'):
                subprocess.run(['node', '--check', str(self.package / entry['path'])], check=True, capture_output=True)
        self.assertEqual(owner.reconcile(self.roots, 'rollback', MANIFEST)['changed'], len(self.entries))
        self.assertEqual(self.snapshot(), before)

    def test_unsupported_last_module_or_symlink_refused_before_any_write(self):
        last = self.package / self.entries[-1]['path']
        last.write_bytes(last.read_bytes() + b'// upgraded')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'unsupported_module_hash'):
            owner.reconcile(self.roots, 'apply', MANIFEST)
        self.assertEqual(before, self.snapshot())
        last.unlink()
        last.symlink_to(self.package / self.entries[0]['path'])
        with self.assertRaisesRegex(ValueError, 'patch_module_path_invalid'):
            owner.reconcile(self.roots, 'apply', MANIFEST)

    def test_partial_write_failure_restores_whole_source_set(self):
        before = self.snapshot()
        real = owner.atomic_write
        calls = 0
        def fail_after_first(path, data):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('authored disk write failure')
            real(path, data)
        with patch.object(owner, 'atomic_write', fail_after_first):
            with self.assertRaises(OSError):
                owner.reconcile(self.roots, 'apply', MANIFEST)
        self.assertEqual(before, self.snapshot())

    def test_cli_supported_version_only(self):
        command = [sys.executable, str(HERE / 'openclaw-compat/whatsapp-network-recovery.py'), '--patch-set', 'model-flow-selection', '--openclaw-root', str(self.package)]
        for mode in ('apply', 'check', 'rollback'):
            result = subprocess.run([*command, '--' + mode], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        (self.package / 'package.json').write_text('{"version":"2026.9.7"}')
        before = self.snapshot()
        result = subprocess.run([*command, '--apply'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsupported_package_version', result.stdout)
        self.assertEqual(self.snapshot(), before)

if __name__ == '__main__':
    unittest.main()
