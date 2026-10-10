#!/usr/bin/env python3
"""Exercise the real sync script with isolated paths and a recorded Git boundary."""
import os
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
            (repo/'state/HYBRID_CONTEXT.md').write_text('old checkpoint\n')
            log = root/'calls'; flag = root/'changed'; flag.touch()
            git = tools/'git'
            git.write_text('#!/bin/bash\nif [ "$1" = status ]; then [ ! -f "$TASK_CHANGED" ] || echo " M state/HYBRID_CONTEXT.md"; else echo "$*" >> "$TASK_CALLS"; fi\n')
            git.chmod(0o700)
            (repo/'scripts/save.sh').write_text('#!/bin/bash\nset -e\ngrep -q "new semantic checkpoint" state/HYBRID_CONTEXT.md\ngrep -q "curated user preference" people/USER.md\necho save >> "$TASK_CALLS"\nrm -f "$TASK_CHANGED"\n')
            env = dict(os.environ, SAMANTHA_CONTEXT_REPO=str(repo), SAMANTHA_CONTEXT_WORKSPACE=str(workspace), TASK_CHANGED=str(flag), TASK_CALLS=str(log), PATH=str(tools)+os.pathsep+os.environ['PATH'])
            subprocess.run(['bash',str(SCRIPT)], env=env,check=True,capture_output=True)
            self.assertEqual(log.read_text(), 'save\n')
            self.assertFalse((repo/'credentials').exists())
            before = (repo/'state/HYBRID_CONTEXT.md').stat().st_mtime_ns
            subprocess.run(['bash',str(SCRIPT)],env=env,check=True,capture_output=True)
            self.assertEqual(log.read_text(), 'save\nsave\nfetch origin\npull --ff-only origin main\n')
            self.assertEqual((repo/'state/HYBRID_CONTEXT.md').stat().st_mtime_ns,before)
    def test_missing_repo_is_noop(self):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run(['bash',str(SCRIPT)],env=dict(os.environ,SAMANTHA_CONTEXT_REPO=root),check=True,capture_output=True)

if __name__ == '__main__': unittest.main()
