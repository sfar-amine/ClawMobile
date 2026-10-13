#!/usr/bin/env python3
"""« Projet Samantha » room: git-tracked files only, secrets and captures excluded, agent provisioned once."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
FAKE = r'''#!/usr/bin/env python3
import json,os,sys
state=os.environ['FAKE_STATE'];cfg=json.load(open(state))
if sys.argv[1:4]==['config','get','agents.entries']:print(json.dumps(cfg['agents']['entries']));sys.exit(0)
if sys.argv[1:3]==['config','patch']:
    patch=json.loads(sys.stdin.read());open(state+'.log','a').write(json.dumps([sys.argv[3:],patch])+'\n')
    if '--dry-run' not in sys.argv:cfg['agents']['entries'].update(patch['agents']['entries']);json.dump(cfg,open(state,'w'))
    sys.exit(0)
sys.exit(2)
'''


def repo(path, files, untracked=()):
    path.mkdir(parents=True)
    subprocess.run(['git', 'init', '-q', str(path)], check=True)
    for rel, text in files.items():
        (path / rel).parent.mkdir(parents=True, exist_ok=True); (path / rel).write_text(text)
    subprocess.run(['git', '-C', str(path), 'add', '-A'], check=True)
    subprocess.run(['git', '-C', str(path), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], check=True)
    for rel, text in untracked: (path / rel).write_text(text)


class ProjectRoomTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); root = Path(self.tmp.name)
        repo(root / 'core', {'README.md': 'Companion', 'src/a.ts': 'export const a=1', 'fixtures/s24/run.json': '{"phone":"+216"}',
                             'leak.ts': 'const k="ghp_' + 'A' * 36 + '"', 'app.env.example': 'X=1'}, untracked=[('.env', 'SECRET=1')])
        repo(root / 'pb', {'docs/README.md': 'Programme', 'tools/x.py': 'print(1)'})
        ws = root / 'ws'; ws.mkdir(); (ws / 'SOUL.md').write_text('# SOUL'); (ws / 'IDENTITY.md').write_text('# ID')
        self.state = root / 'cfg.json'
        self.state.write_text(json.dumps({'agents': {'entries': {'contacts': {'model': {'primary': 'm'}, 'workspace': 'x',
                                                                                'tools': {'allow': ['web_search'], 'deny': ['exec', 'read', 'write']}}}}}))
        fake = root / 'openclaw'; fake.write_text(FAKE); fake.chmod(0o755)
        self.target = root / 'workspace-projet'
        self.env = dict(os.environ, HOME=str(root), CLAW_PROJECT_ROOM_DIR=str(self.target), CLAW_PROJECT_CORE=str(root / 'core'),
                        CLAW_PROJECT_PLAYBOOKS=str(root / 'pb'), CLAW_OWNER_WORKSPACE=str(ws), CLAW_OPENCLAW_BIN=str(fake), FAKE_STATE=str(self.state))

    def tearDown(self):
        self.tmp.cleanup()

    def run_room(self, command):
        return json.loads(subprocess.check_output([sys.executable, str(HERE / 'project-room.py'), command], env=self.env, text=True))

    def test_build_copies_tracked_files_only_and_drops_secrets_and_captures(self):
        out = self.run_room('build')
        self.assertTrue((self.target / 'samantha-core/src/a.ts').is_file())
        self.assertTrue((self.target / 'ui-playbooks/docs/README.md').is_file())
        for absent in ('samantha-core/.env', 'samantha-core/fixtures/s24/run.json', 'samantha-core/leak.ts', 'samantha-core/app.env.example'):
            self.assertFalse((self.target / absent).exists(), absent)
        self.assertEqual(out['droppedSecretLike'], 1)
        for name in ('AGENTS.md', 'USER.md', 'SOUL.md', 'IDENTITY.md'): self.assertTrue((self.target / name).is_file())
        index = (self.target / 'INDEX.md').read_text(encoding='utf-8').splitlines()
        self.assertIn('samantha-core/src/a.ts', index); self.assertIn('ui-playbooks/docs/README.md', index)
        self.assertEqual(len([l for l in index if '/' in l]), out['copied'])
        self.run_room('build'); self.assertFalse(self.target.with_name('workspace-projet.next').exists())

    def test_provision_adds_a_read_only_workspace_confined_agent_once(self):
        self.assertEqual(self.run_room('provision')['agent'], 'provisioned')
        entry = json.loads(self.state.read_text())['agents']['entries']['contacts-projet']
        self.assertEqual(entry['workspace'], str(self.target)); self.assertEqual(entry['tools']['allow'], ['web_search', 'read'])
        self.assertTrue(entry['tools']['fs']['workspaceOnly']); self.assertNotIn('read', entry['tools']['deny']); self.assertIn('exec', entry['tools']['deny'])
        log = [json.loads(l) for l in Path(str(self.state) + '.log').read_text().splitlines()]
        self.assertEqual([args for args, _ in log], [['--stdin', '--dry-run'], ['--stdin']])
        self.assertEqual(self.run_room('provision')['agent'], 'present')


if __name__ == '__main__':
    unittest.main()
