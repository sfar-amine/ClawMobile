"""I9 regressions: incident identity/dedup, context alerts and J1 effective reads."""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parent

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

class I9NoiseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name)/'home';self.home.mkdir()
        self.runtime=Path(self.tmp.name)/'runtime';self.runtime.mkdir()
        self.env={**os.environ,'HOME':str(self.home),'CLAW_RUNTIME_ROOT':str(self.runtime)}
        for name in ('incident-notify.sh','incident-close.sh'):
            self.write(name,(ROOT/name).read_text().replace('#!/data/data/com.termux/files/usr/bin/bash','#!/usr/bin/env bash',1))
        self.write('learning-gate-close.sh','#!/bin/sh\necho "{}"\n')
        self.write('whatsapp-owner-send.sh','#!/bin/sh\nexit 0\n')
        self.write('incident-email.sh','#!/bin/sh\nexit 0\n')

    def write(self,name,text):
        path=self.runtime/name;path.write_text(text);path.chmod(0o755)

    def bash(self,name,*args,env=None):
        return subprocess.run(['bash',str(self.runtime/name),*args],env=env or self.env,
                              text=True,capture_output=True,timeout=10,check=True)

    def queue(self):
        return self.home/'.openclaw/incidents/queue'

    def test_same_active_alert_is_queued_once_and_can_recur_after_close(self):
        self.bash('incident-notify.sh','remote_desktop','RDC unavailable')
        folder=next(self.queue().iterdir())
        self.assertEqual((folder/'component').read_text(),'remote_desktop')
        self.bash('incident-notify.sh','remote_desktop','RDC unavailable')
        events=(self.home/'.openclaw/incidents/events.log').read_text().splitlines()
        self.assertEqual(sum('event=queued' in row for row in events),1)
        (folder/'status').write_text('notified')
        self.bash('incident-notify.sh','remote_desktop','RDC unavailable')
        self.assertEqual((folder/'status').read_text(),'notified')
        (folder/'status').write_text('closed')
        self.bash('incident-notify.sh','remote_desktop','RDC unavailable')
        self.assertEqual((folder/'status').read_text(),'pending')
        events=(self.home/'.openclaw/incidents/events.log').read_text().splitlines()
        self.assertEqual(sum('event=queued' in row for row in events),2)

    def test_close_uses_exact_legacy_token_identity(self):
        self.bash('incident-notify.sh','human_required','ADB recovery unavailable','manual action')
        self.bash('incident-notify.sh','human_required','adb_watchdog unavailable','manual action')
        rows={p.joinpath('message').read_text():p for p in self.queue().iterdir()}
        self.bash('incident-close.sh','adb','ADB recovered')
        self.assertEqual(rows['ADB recovery unavailable'].joinpath('status').read_text(),'closed')
        self.assertEqual(rows['adb_watchdog unavailable'].joinpath('status').read_text(),'pending')

    def test_context_guardian_alert_is_deduplicated(self):
        self.write('context-guardian.sh',(ROOT/'context-guardian.sh').read_text().replace('#!/data/data/com.termux/files/usr/bin/bash','#!/usr/bin/env bash',1))
        bindir=Path(self.tmp.name)/'bin';bindir.mkdir()
        fake=bindir/'openclaw';fake.write_text('#!/bin/sh\nexit 1\n');fake.chmod(0o755)
        env={**self.env,'PATH':str(bindir)+os.pathsep+self.env['PATH']}
        self.bash('context-guardian.sh',env=env);self.bash('context-guardian.sh',env=env)
        folders=list(self.queue().iterdir());self.assertEqual(len(folders),1)
        self.assertEqual(folders[0].joinpath('component').read_text(),'context_guardian')
        events=(self.home/'.openclaw/incidents/events.log').read_text().splitlines()
        self.assertEqual(sum('event=queued' in row for row in events),1)

    def test_j1_reads_a_real_file_instead_of_reporting_zero(self):
        hook=load('i9_j1_hook','nightly-secret-scan.py')
        scanned=Path(self.tmp.name)/'scan';scanned.mkdir()
        (scanned/'plain.txt').write_text('public fixture without credentials\n')
        def runner(command,timeout):
            proc=subprocess.run(command,text=True,capture_output=True,timeout=timeout)
            return proc.returncode,json.loads(proc.stdout)
        result,attention=hook.execute_scan(ROOT,[('effective',scanned)],[],runner)
        self.assertEqual(result['state'],'ok')
        self.assertGreaterEqual(result['stats']['files'],1)
        self.assertFalse(attention)

if __name__=='__main__':unittest.main(verbosity=2)
