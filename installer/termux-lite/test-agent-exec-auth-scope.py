#!/usr/bin/env python3
"""Pinned compatibility transaction on captured public native source; no secrets."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
OWNER = HERE / 'openclaw-compat/whatsapp-network-recovery.py'
spec = importlib.util.spec_from_file_location('native_compat', OWNER)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
MANIFEST = OWNER.with_name('agent-exec-auth-scope.json')
FIXTURE = HERE.parent.parent / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-23-native-auth-scope/runtime-BnnQBrxr.mjs'


class NativeAuthScopePatch(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.path = self.root / 'dist' / FIXTURE.name
        self.path.parent.mkdir()
        self.path.write_bytes(FIXTURE.read_bytes())
        (self.root / 'package.json').write_text('{"version":"2026.9.6"}')

    def cli(self, mode):
        return subprocess.run([sys.executable, str(OWNER), '--patch-set', 'agent-exec-auth-scope',
                               '--openclaw-root', str(self.root), '--' + mode], capture_output=True, text=True)

    def test_exact_capture_apply_check_idempotence_and_restore(self):
        before = self.path.read_bytes()
        self.assertNotEqual(self.cli('check').returncode, 0)
        for mode in ('apply', 'check', 'apply', 'rollback'):
            result = self.cli(mode)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.path.read_bytes(), before)

    def test_unknown_source_is_refused_without_write(self):
        self.path.write_bytes(self.path.read_bytes() + b'// drift\n')
        before = self.path.read_bytes()
        result = self.cli('apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsupported_module_hash', result.stdout)
        self.assertEqual(self.path.read_bytes(), before)

    def test_unknown_version_is_refused_without_write(self):
        before = self.path.read_bytes()
        (self.root / 'package.json').write_text('{"version":"2099.1.1"}')
        self.assertNotEqual(self.cli('apply').returncode, 0)
        self.assertEqual(self.path.read_bytes(), before)

    def test_symlink_is_refused_without_changing_target(self):
        original = self.path.read_bytes()
        target = self.root / 'outside.mjs'
        target.write_bytes(original)
        self.path.unlink()
        self.path.symlink_to(target)
        self.assertNotEqual(self.cli('apply').returncode, 0)
        self.assertEqual(target.read_bytes(), original)

    def test_manifest_forward_and_reverse_match_pinned_capture(self):
        entry = json.loads(MANIFEST.read_text())['files'][0]
        original = FIXTURE.read_bytes()
        self.assertEqual(owner.digest(original), entry['original'])
        fixed = owner.transform(original, entry)
        self.assertEqual(owner.digest(fixed), entry['patched'])
        self.assertEqual(owner.transform(fixed, entry, reverse=True), original)

    def test_start_uses_checkout_ownership_and_restores_after_rollback(self):
        import os
        source = (HERE / 'gateway-start.sh').read_text()
        block = source[source.index('AUTH_PATCH_DIR='):source.index('echo "[lite] Starting')]
        checkout = self.root / 'checkout'
        release = self.root / 'release'
        target = checkout / 'installer/termux-lite/openclaw-compat'
        for folder in (target, release / 'openclaw-compat'):
            folder.mkdir(parents=True)
            (folder / 'agent-exec-auth-scope.json').write_text('{}')
            (folder / 'whatsapp-network-recovery.py').write_text('import sys\nprint(sys.argv[-1])\n')
        env = {**os.environ, 'CLAW_CORE_REPO': str(checkout), 'SCRIPT_DIR': str(release)}
        result = subprocess.run(['bash', '-c', block], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--apply', result.stderr)
        (target / 'agent-exec-auth-scope.json').unlink()
        result = subprocess.run(['bash', '-c', block], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--rollback', result.stderr)


if __name__ == '__main__':
    unittest.main()
