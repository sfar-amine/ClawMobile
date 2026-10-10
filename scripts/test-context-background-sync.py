#!/usr/bin/env python3
"""Exercise the real sync script with isolated paths and a recorded Git boundary."""
import os
import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('sync-context-background.sh')

class SyncTest(unittest.TestCase):
    def test_copy_before_save_and_skip_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root); repo = root/'private'; workspace = root/'workspace'; tools = root/'bin'
            (repo/'.git').mkdir(parents=True); (repo/'scripts').mkdir(); (repo/'state').mkdir()
            (workspace/'context').mkdir(parents=True); tools.mkdir()
            (workspace/'context/HYBRID_CONTEXT.md').write_text('new semantic checkpoint\n')
            (workspace/'USER.md').write_text('curated user preference\n')
            (workspace/'credentials').mkdir(); (workspace/'credentials/private.key').write_text('must never copy')
            (repo/'HYBRID_CONTEXT.md').write_text('old checkpoint\n')
            log = root/'calls'; flag = root/'changed'; flag.touch()
            git = tools/'git'
            git.write_text('#!/bin/bash\nif [ "$1" = status ]; then [ ! -f "$TASK_CHANGED" ] || echo " M HYBRID_CONTEXT.md"; else echo "$*" >> "$TASK_CALLS"; fi\n')
            git.chmod(0o700)
            (repo/'scripts/save.sh').write_text('#!/bin/bash\nset -e\ngrep -q "new semantic checkpoint" HYBRID_CONTEXT.md\ngrep -q "curated user preference" people/USER.md\necho save >> "$TASK_CALLS"\nrm -f "$TASK_CHANGED"\n')
            env = dict(os.environ, SAMANTHA_CONTEXT_REPO=str(repo), SAMANTHA_CONTEXT_WORKSPACE=str(workspace), TASK_CHANGED=str(flag), TASK_CALLS=str(log), PATH=str(tools)+os.pathsep+os.environ['PATH'])
            subprocess.run(['bash',str(SCRIPT)], env=env,check=True,capture_output=True)
            self.assertEqual(log.read_text(), 'save\n')
            self.assertFalse((repo/'credentials').exists())
            before = (repo/'HYBRID_CONTEXT.md').stat().st_mtime_ns
            subprocess.run(['bash',str(SCRIPT)],env=env,check=True,capture_output=True)
            self.assertEqual(log.read_text(), 'save\nsave\nfetch origin\npull --ff-only origin main\n')
            self.assertEqual((repo/'HYBRID_CONTEXT.md').stat().st_mtime_ns,before)
    def test_captured_save_makes_real_commit_only_when_changed(self):
        fixture_path = SCRIPT.parent.parent/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/c7/private-sync-installed.json'
        capture = json.loads(fixture_path.read_text())
        captured_save = capture['scripts']['save.sh']
        self.assertEqual(hashlib.sha256(captured_save['code'].encode()).hexdigest(), captured_save['sha256'])
        self.assertEqual(capture['cron']['schedule'], 'every 900000 ms')
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); repo=root/'private'; workspace=root/'workspace'; remote=root/'remote.git'
            repo.mkdir(); (repo/'scripts').mkdir(); (repo/'people').mkdir(); (repo/'state').mkdir()
            (workspace/'context').mkdir(parents=True)
            # Run the actual installed owner, adapting only its workspace input.
            # HOME is never changed; backup-runtime-state is a deterministic boundary
            # because private databases were intentionally absent from the capture.
            save = captured_save['code'].replace('WS="$HOME/.openclaw/workspace"', 'WS="${SAMANTHA_CONTEXT_WORKSPACE:?}"')
            (repo/'scripts/save.sh').write_text(save)
            (repo/'scripts/backup-runtime-state.py').write_text('from pathlib import Path\np=Path("state/runtime-continuity/manifest.json")\np.parent.mkdir(parents=True,exist_ok=True)\np.write_text("{}\\n")\n')
            def git(*args, cwd=repo):
                return subprocess.run(['git',*args], cwd=cwd, check=True, capture_output=True,text=True).stdout.strip()
            git('init','--bare',str(remote),cwd=root)
            git('init','-b','main'); git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture')
            git('add','.');git('commit','-m','fixture owner baseline');git('remote','add','origin',str(remote));git('push','-u','origin','main')
            baseline=git('rev-parse','HEAD')
            for item in capture['snapshotMapping'][:6]:
                relative=item['source'].split('~/.openclaw/workspace/')[1]
                path=workspace/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('synthetic curated '+relative+'\n')
            # The managed links are outside the snapshot allowlist and stay untouched.
            links=[]
            for item in capture['managedSymlinksInWorkspace']:
                link=workspace/item['link'].split('~/.openclaw/workspace/')[1]
                target=repo/item['target'].split('~/samantha-context-private/')[1]
                link.parent.mkdir(parents=True,exist_ok=True);link.symlink_to(target);links.append((link,str(target)))
            env=dict(os.environ,SAMANTHA_CONTEXT_REPO=str(repo),SAMANTHA_CONTEXT_WORKSPACE=str(workspace))
            subprocess.run(['bash',str(SCRIPT)],env=env,check=True,capture_output=True)
            changed=git('rev-parse','HEAD');self.assertNotEqual(baseline,changed)
            self.assertEqual(git('rev-list','--count',f'{baseline}..HEAD'),'1')
            self.assertEqual(git('rev-parse','refs/heads/main',cwd=remote),changed)
            self.assertEqual((repo/'HYBRID_CONTEXT.md').read_text(),(workspace/'context/HYBRID_CONTEXT.md').read_text())
            self.assertFalse((repo/'state/HYBRID_CONTEXT.md').exists())
            for item in capture['snapshotMapping'][:5]:
                relative=item['destination'].split('~/samantha-context-private/')[1]
                self.assertTrue((repo/relative).is_file())
            subprocess.run(['bash',str(SCRIPT)],env=env,check=True,capture_output=True)
            self.assertEqual(git('rev-parse','HEAD'),changed);self.assertEqual(git('status','--porcelain'),'')
            for link,target in links:self.assertEqual(os.readlink(link),target)
            # A semantic export change also commits even when the six snapshots match.
            export=repo/'scripts/backup-runtime-state.py'
            export.write_text(export.read_text().replace('"{}', '"{\\"revision\\":2}'))
            git('add','.');git('commit','-m','change synthetic semantic owner');git('push','origin','main')
            prior=git('rev-parse','HEAD')
            subprocess.run(['bash',str(SCRIPT)],env=env,check=True,capture_output=True)
            self.assertNotEqual(git('rev-parse','HEAD'),prior)
            self.assertEqual(git('rev-list','--count',f'{prior}..HEAD'),'1')

    def test_missing_repo_is_noop(self):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run(['bash',str(SCRIPT)],env=dict(os.environ,SAMANTHA_CONTEXT_REPO=root),check=True,capture_output=True)
    def test_source_target_and_ancestor_links_refused(self):
        for linked in ('source','target','ancestor'):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as root:
                root=pathlib.Path(root); repo=root/'private'; workspace=root/'workspace'; outside=root/'outside'
                (repo/'.git').mkdir(parents=True); (repo/'scripts').mkdir(); (workspace/'context').mkdir(parents=True)
                (repo/'scripts/save.sh').write_text('exit 99\n')
                outside.mkdir(); protected=outside/'HYBRID_CONTEXT.md'; protected.write_text('must preserve')
                source=workspace/'context/HYBRID_CONTEXT.md'
                if linked=='source': source.symlink_to(protected)
                else: source.write_text('new semantic checkpoint')
                if linked=='ancestor':
                    (workspace/'USER.md').write_text('curated preference')
                    (repo/'people').symlink_to(outside,target_is_directory=True)
                elif linked=='target': (repo/'HYBRID_CONTEXT.md').symlink_to(protected)
                result=subprocess.run(['bash',str(SCRIPT)],env=dict(os.environ,SAMANTHA_CONTEXT_REPO=str(repo),SAMANTHA_CONTEXT_WORKSPACE=str(workspace)),capture_output=True,text=True)
                self.assertEqual(result.returncode,66)
                self.assertIn('private_context_link_refused',result.stderr)
                self.assertEqual(protected.read_text(),'must preserve')

if __name__ == '__main__': unittest.main()
