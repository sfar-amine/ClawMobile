#!/usr/bin/env python3
"""Mobile updates preserve the compact common core and managed block ownership."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
text = (ROOT / 'lib.sh').read_text()
function = text.split('clawmobile_sync_marked_block() {', 1)[1].split('\n}\n', 1)[0]
command = 'clawmobile_sync_marked_block() {' + function + '\n}\nclawmobile_sync_marked_block "$1" "$2"'


class InstallerTests(unittest.TestCase):
    def test_compact_core_is_unchanged_on_repeated_mobile_updates(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); core = root / 'AGENTS.md'; core.write_text('<!-- CONTEXT_RULES_COMPACT_V1 -->\nIdentity and constraints.\n')
            module = root / 'context/rules/mobile.md'; module.parent.mkdir(parents=True); module.write_text('Specialized rules.\n')
            block = root / 'block.md'; block.write_text('<!-- CLAWMOBILE_BEGIN -->\nObserve before acting.\n<!-- CLAWMOBILE_END -->\n')
            before = core.read_bytes()
            for _ in range(2): subprocess.run(['bash', '-c', command, 'test', str(core), str(block)], check=True, capture_output=True)
            self.assertEqual(core.read_bytes(), before)
            self.assertEqual(module.read_text().count('CLAWMOBILE_BEGIN'), 1)
            self.assertIn('Specialized rules.', module.read_text())
            module.unlink()
            self.assertNotEqual(subprocess.run(['bash', '-c', command, 'test', str(core), str(block)], capture_output=True).returncode, 0)
            self.assertEqual(core.read_bytes(), before)

    def test_original_nonmodular_target_still_works(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); core = root / 'AGENTS.md'; core.write_text('Original constraints.\n')
            block = root / 'block.md'; block.write_text('<!-- CLAWMOBILE_BEGIN -->\nRule.\n<!-- CLAWMOBILE_END -->\n')
            subprocess.run(['bash', '-c', command, 'test', str(core), str(block)], check=True, capture_output=True)
            self.assertIn('Original constraints.', core.read_text()); self.assertIn('Rule.', core.read_text())


if __name__ == '__main__': unittest.main(verbosity=2)
