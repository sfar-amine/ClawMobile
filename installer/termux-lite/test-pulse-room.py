#!/usr/bin/env python3
"""Pièce « Pulse » : the two room agents are cloned from the closed contact agents, once, never from main."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
FAKE = (HERE / 'test-project-room.py').read_text().split("FAKE = r'''", 1)[1].split("'''", 1)[0]
DENY = ['exec', 'process', 'write', 'memory_search', 'clawmobile_capability']


class PulseRoomTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); root = Path(self.tmp.name)
        ws = root / 'ws'; ws.mkdir(); (ws / 'SOUL.md').write_text('# SOUL')
        self.state = root / 'cfg.json'
        self.state.write_text(json.dumps({'agents': {'entries': {
            'main': {'tools': {}},
            'contacts': {'model': {'primary': 'm'}, 'workspace': 'wc', 'tools': {'allow': ['web_search'], 'deny': DENY + ['read']}},
            'contacts-projet': {'model': {'primary': 'm'}, 'workspace': str(root / 'wp'), 'tools': {'allow': ['web_search', 'read'], 'fs': {'workspaceOnly': True}, 'deny': DENY}}}}}))
        fake = root / 'openclaw'; fake.write_text(FAKE); fake.chmod(0o755)
        self.target = root / 'workspace-pulse'
        self.env = dict(os.environ, HOME=str(root), CLAW_PULSE_ROOM_DIR=str(self.target), CLAW_OWNER_WORKSPACE=str(ws),
                        CLAW_OPENCLAW_BIN=str(fake), FAKE_STATE=str(self.state), SAMANTHA_BRAIN_ONLY="0")

    def tearDown(self):
        self.tmp.cleanup()

    def provision(self):
        return subprocess.run([sys.executable, str(HERE / 'pulse-room.py'), 'provision'], env=self.env, text=True, capture_output=True)

    def test_provision_clones_closed_contact_agents_once(self):
        out = self.provision(); self.assertEqual(0, out.returncode, out.stderr)
        self.assertEqual(['contacts-projet-pulse', 'contacts-pulse'], json.loads(out.stdout)['agents'])
        entries = json.loads(self.state.read_text())['agents']['entries']
        pulse, both = entries['contacts-pulse'], entries['contacts-projet-pulse']
        self.assertEqual(str(self.target), pulse['workspace']); self.assertIn('read', pulse['tools']['deny'])
        self.assertEqual(entries['contacts-projet']['workspace'], both['workspace']); self.assertEqual(['web_search', 'read', 'transmettre_a_amine', 'noter_contact'], both['tools']['allow'])
        for entry in (pulse, both):
            self.assertIn('clawmobile_capability', entry['tools']['deny']); self.assertNotEqual(entries['main'].get('tools'), entry['tools'])
        self.assertIn('Une demande de congé se fait uniquement par Amine', (self.target / 'AGENTS.md').read_text())
        self.assertTrue((self.target / 'SOUL.md').is_file())
        again = self.provision(); self.assertEqual('present', json.loads(again.stdout)['agents'])
        log = (Path(str(self.state) + '.log')).read_text().splitlines(); self.assertEqual(2, len(log))  # dry-run + apply, once

    def test_brain_projects_existing_pulse_grant_without_owner_tools_and_rollback(self):
        self.env['SAMANTHA_BRAIN_ONLY']='1'
        out=self.provision();self.assertEqual(0,out.returncode,out.stderr)
        entries=json.loads(self.state.read_text())['agents']['entries']
        for name in ('contacts-pulse','contacts-projet-pulse'):
            tools=entries[name]['tools']
            self.assertIn('samantha_pulse',tools['allow'])
            self.assertIn('exec',tools['deny']);self.assertIn('clawmobile_capability',tools['deny'])
            self.assertNotIn('samantha_app',tools['allow']);self.assertNotIn('samantha_billing',tools['allow'])
        text=(self.target/'AGENTS.md').read_text()
        self.assertIn('message original entier',text)
        self.assertNotIn('exécutées automatiquement avant toi',text)
        self.env['SAMANTHA_BRAIN_ONLY']='0'
        out=self.provision();self.assertEqual(0,out.returncode,out.stderr)
        for name in ('contacts-pulse','contacts-projet-pulse'):
            self.assertNotIn('samantha_pulse',json.loads(self.state.read_text())['agents']['entries'][name]['tools']['allow'])

    def test_an_open_contact_agent_is_never_cloned(self):
        cfg = json.loads(self.state.read_text()); cfg['agents']['entries']['contacts']['tools']['deny'] = ['write']
        self.state.write_text(json.dumps(cfg))
        out = self.provision(); self.assertNotEqual(0, out.returncode); self.assertIn('room_agent_tools_not_closed', out.stderr)
        self.assertNotIn('contacts-pulse', json.loads(self.state.read_text())['agents']['entries'])


if __name__ == '__main__':
    unittest.main()
