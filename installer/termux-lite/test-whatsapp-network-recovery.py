#!/usr/bin/env python3
"""Exercise patch transactions on real, sanitized S24 source fixtures."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("wa_patch", HERE / "openclaw-compat/whatsapp-network-recovery.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
FIXTURE = HERE.parent.parent / "openclaw-plugin-mobile-ui/fixtures/s24-2026-10-16-whatsapp-recovery"

class PatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.roots = {k: base/k for k in ("openclaw", "whatsapp")}
        for k, dest in self.roots.items(): shutil.copytree(FIXTURE/k, dest)
        self.entries = json.loads(mod.MANIFEST.read_text())["files"]
    def snapshot(self):
        return {e["path"]:(self.roots[e["root"]]/e["path"]).read_bytes() for e in self.entries}
    def cli(self, *args, **env):
        for root in self.roots.values():
            if not (root/"package.json").exists(): (root/"package.json").write_text('{"version":"2026.9.6"}')
        return subprocess.run([sys.executable,str(HERE/"openclaw-compat/whatsapp-network-recovery.py"),
                               "--openclaw-root",str(self.roots["openclaw"]),*args],
                              env={**os.environ,**env},capture_output=True,text=True)
    def test_cli_version_guard_and_no_writes_on_upgrade(self):
        (self.roots["whatsapp"]/"package.json").write_text('{"version":"2026.10.1"}')
        before=self.snapshot()
        p=self.cli("--apply","--whatsapp-root",str(self.roots["whatsapp"]))
        self.assertNotEqual(p.returncode,0);self.assertIn("unsupported_package_version",p.stdout)
        self.assertEqual(before,self.snapshot())
    def test_cli_does_not_guess_between_package_generations(self):
        state=Path(self.tmp.name)/"state"
        for name in ("old","new"): (state/"npm/projects"/name/"node_modules/@openclaw/whatsapp").mkdir(parents=True)
        p=self.cli("--apply",OPENCLAW_STATE_DIR=str(state))
        self.assertNotEqual(p.returncode,0);self.assertIn("missing_or_ambiguous",p.stdout)
    def test_cli_apply_check_rollback(self):
        before=self.snapshot()
        for mode in ("apply","check","apply","rollback"):
            p=self.cli("--"+mode,"--whatsapp-root",str(self.roots["whatsapp"]))
            self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        self.assertEqual(before,self.snapshot())
    def test_apply_verify_idempotent_and_exact_rollback(self):
        before=self.snapshot()
        self.assertFalse(mod.reconcile(self.roots,"check")["ok"])
        self.assertEqual(mod.reconcile(self.roots,"apply")["changed"],3)
        self.assertTrue(mod.reconcile(self.roots,"check")["ok"])
        self.assertEqual(mod.reconcile(self.roots,"apply")["changed"],0)
        self.assertEqual(mod.reconcile(self.roots,"rollback")["changed"],3)
        self.assertEqual(before,self.snapshot())
    def test_unknown_module_refused_before_any_write(self):
        entry=self.entries[-1]; p=self.roots[entry["root"]]/entry["path"]; p.write_text(p.read_text()+"// changed\n")
        before=self.snapshot()
        with self.assertRaisesRegex(ValueError,"unsupported_module_hash"): mod.reconcile(self.roots,"apply")
        self.assertEqual(before,self.snapshot())
    def test_partial_apply_is_recoverable(self):
        e=self.entries[0]; p=self.roots[e["root"]]/e["path"]; p.write_bytes(mod.transform(p.read_bytes(),e))
        self.assertEqual(mod.reconcile(self.roots,"apply")["changed"],2)
        self.assertTrue(mod.reconcile(self.roots,"check")["ok"])
    def test_write_failure_restores_already_written_modules(self):
        before=self.snapshot(); real=mod.atomic_write; calls=0
        def failing(path,data):
            nonlocal calls
            calls+=1
            if calls==2: raise OSError("injected write failure")
            real(path,data)
        with patch.object(mod,"atomic_write",failing):
            with self.assertRaises(OSError): mod.reconcile(self.roots,"apply")
        self.assertEqual(before,self.snapshot())

if __name__=="__main__": unittest.main()
