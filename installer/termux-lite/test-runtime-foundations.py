#!/usr/bin/env python3
"""Static foundation contracts: no device, provider, process control or payment."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('foundation_runtime_mode', HERE/'runtime_mode.py')
mode = importlib.util.module_from_spec(spec); spec.loader.exec_module(mode)


class RuntimeFoundations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.core = self.root/'core'; self.pb = self.root/'playbooks'
        for rel in ('installer/termux-lite/model-fast-path.py', 'openclaw-plugin-mobile-ui/src/companion/runWeb.ts', 'openclaw-plugin-mobile-ui/fixtures/protocol/voice-v2-app-companion.json'):
            dest = self.core/rel; dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(HERE.parent.parent/rel, dest)
        owner = self.pb/'skill_intelligence/public_web.py'; owner.parent.mkdir(parents=True)
        owner.write_text('BUDGET_MS = 20000\nSEARCH_BUDGET_MS = 12000\n')
        self.app = self.root/'app-contract.json'
        self.contract = self.core/'openclaw-plugin-mobile-ui/fixtures/protocol/voice-v2-app-companion.json'
        shutil.copy2(self.contract, self.app)

    def test_static_contracts_match(self):
        self.assertEqual(mode.contract_drift(self.core, self.pb, self.app), [])

    def test_without_app_source_the_runtime_contract_is_still_checked(self):
        self.app.unlink()
        self.assertEqual(mode.contract_drift(self.core, self.pb), [])
        value = json.loads(self.contract.read_text()); value.pop('correlation')
        self.contract.write_text(json.dumps(value))
        self.assertIn('voice:correlation_contract', mode.contract_drift(self.core, self.pb))

    def test_missing_runtime_contract_is_distinct_from_missing_app_copy(self):
        self.contract.unlink()
        drift = mode.contract_drift(self.core, self.pb)
        self.assertIn('voice:runtime_contract_unavailable', drift)
        self.assertNotIn('voice:app_contract_unavailable', drift)

    def test_owner_budget_change_refuses_both_copies(self):
        (self.pb/'skill_intelligence/public_web.py').write_text('BUDGET_MS=25000\nSEARCH_BUDGET_MS=12000\n')
        self.assertCountEqual(mode.contract_drift(self.core, self.pb, self.app), ['budget:web_companion', 'budget:web_fast_path'])

    def test_missing_owner_or_app_contract_is_not_parity(self):
        self.app.unlink()
        self.assertIn('voice:app_contract_unavailable', mode.contract_drift(self.core, self.pb, self.app))
        (self.pb/'skill_intelligence/public_web.py').unlink()
        self.assertIn('budget:web_contract_unavailable', mode.contract_drift(self.core, self.pb, self.app))

    def test_correlation_added_to_owner_without_copy_fails_byte_parity(self):
        value = json.loads(self.contract.read_text()); value['correlation']['values'].append('future_value')
        self.contract.write_text(json.dumps(value))
        self.assertIn('voice:app_contract_differs', mode.contract_drift(self.core, self.pb, self.app))

    def test_parity_never_imports_owner_code(self):
        with (self.pb/'skill_intelligence/public_web.py').open('a') as f:
            f.write('raise RuntimeError("must never execute owner source")\n')
        self.assertEqual(mode.contract_drift(self.core, self.pb, self.app), [])

    def test_python_and_shell_read_the_same_tier0_root_without_mutating_it(self):
        selected = str(self.root/'release/termux-lite')
        with patch.dict(os.environ, {'CLAW_RUNTIME_ROOT': selected}):
            self.assertEqual(str(mode.runtime_root()), selected)
            before = dict(os.environ)
            out = subprocess.run(['bash', '-c', 'source "$1"; clawmobile_runtime_root', '_', str(HERE/'lib.sh')], capture_output=True, text=True, check=True)
            self.assertEqual(out.stdout.strip(), selected)
            self.assertEqual(dict(os.environ), before)

    def test_both_observed_process_roots_remain_distinct(self):
        capture = json.loads((HERE.parent.parent/'openclaw-plugin-mobile-ui/fixtures/foundations/s24-runtime-roots-20261018.json').read_text())
        self.assertTrue(capture['sanitized'])
        self.assertEqual(capture['root_unit'], 'termux-lite')
        values = []
        for role in ('supervisors', 'companion'):
            observed = capture[role]['root'].replace('~', str(self.root/'phone-home'), 1)
            with patch.dict(os.environ, {'CLAW_RUNTIME_ROOT': observed}):
                values.append(mode.runtime_root())
        self.assertNotEqual(*values)

    def test_helper_consumers_do_not_reconstruct_current_link(self):
        repo = HERE.parent.parent
        for relative in ('openclaw-plugin-mobile-ui/src/capabilityTool.ts', 'openclaw-plugin-mobile-ui/src/companion/capabilityBridge.ts', 'openclaw-plugin-mobile-ui/src/companion/clawLive.ts', 'openclaw-plugin-mobile-ui/src/modelFastPath.ts', 'openclaw-plugin-mobile-ui/src/companion/control.ts', 'openclaw-plugin-mobile-ui/src/companion/memoryControl.ts', 'openclaw-plugin-mobile-ui/src/contactTools.ts'):
            source = (repo/relative).read_text()
            self.assertNotIn('releases/current', source, relative)
            self.assertIn('runtimeFile(', source, relative)
        for name in ('model-fast-path.py', 'gemini-request.py', 'claw-slack-purge-setup.sh'):
            self.assertNotIn('releases/current', (HERE/name).read_text(), name)

    def test_relative_root_is_refused_instead_of_following_cwd(self):
        with patch.dict(os.environ, {'CLAW_RUNTIME_ROOT': '../old-release'}):
            with self.assertRaisesRegex(ValueError, 'runtime_root_not_absolute'): mode.runtime_root()
            out = subprocess.run(['bash','-c','source "$1"; clawmobile_runtime_root','_',str(HERE/'lib.sh')],capture_output=True,text=True)
            self.assertNotEqual(out.returncode, 0)


if __name__ == '__main__': unittest.main()
