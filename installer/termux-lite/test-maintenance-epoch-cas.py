#!/usr/bin/env python3
"""Real existing maintenance owner on temporary HOME; no deploy or runtime calls."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

OWNER = Path(__file__).resolve().with_name('companion-deploy.sh')


class MaintenanceCasTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name)
        self.directory=self.home/'.openclaw/samantha-dialogue'
        self.marker=self.directory/'maintenance.json'
        self.env={**os.environ,'HOME':str(self.home),'CLAW_DIALOGUE_HOME':str(self.directory),
                  'COMPANION_MAINTENANCE_LOCK_WAIT_S':'0'}
        self.env.pop('CLAW_RUNTIME_ROOT',None)

    def run_owner(self,*args,**env):
        return subprocess.run(['bash',str(OWNER),'--maintenance',*args],
                              env={**self.env,**env},capture_output=True,text=True,timeout=3)

    def ok(self,*args):
        result=self.run_owner(*args)
        self.assertEqual(result.returncode,0,result.stderr)
        return json.loads(result.stdout)

    def close(self):return self.ok('close')

    def open_args(self,row):
        return ('open','--expected-epoch',str(row['epoch']),'--expected-revision',row['revision'])

    def test_capability_contract_explicit_version(self):
        result=self.ok('capabilities')
        self.assertEqual(result,{'version':1,'owner':'companion-deploy.sh',
                                 'expected_epoch_open':True,'expected_revision_open':True})
        self.assertFalse(self.marker.exists())

    def test_changed_epoch99_refuses_without_any_marker_write(self):
        owned=self.close()
        changed=json.loads(self.marker.read_text());changed['epoch']=99
        self.marker.write_text(json.dumps(changed));before=self.marker.read_bytes()
        result=self.run_owner(*self.open_args(owned))
        self.assertEqual((result.returncode,result.stderr.strip()),(4,'maintenance_epoch_mismatch'))
        self.assertEqual(self.marker.read_bytes(),before)
        self.assertEqual(json.loads(before)['state'],'closed')

    def test_second_canonical_close_same_epoch_revokes_first_revision(self):
        owned=self.close();urgent=self.close()
        self.assertEqual(owned['epoch'],urgent['epoch'])
        self.assertNotEqual(owned['revision'],urgent['revision'])
        before=self.marker.read_bytes()
        result=self.run_owner(*self.open_args(owned))
        self.assertEqual(result.returncode,4)
        self.assertEqual(self.marker.read_bytes(),before)
        self.assertEqual(json.loads(before)['state'],'closed')

    def test_repeated_scoped_open_same_revision_is_idempotent(self):
        owned=self.close();first=self.ok(*self.open_args(owned));before=self.marker.read_bytes()
        repeated=self.ok(*self.open_args(owned))
        self.assertEqual((first['state'],repeated['state']),('open','open'))
        self.assertTrue(repeated['unchanged']);self.assertEqual(repeated['revision'],owned['revision'])
        self.assertEqual(self.marker.read_bytes(),before)

    def test_legacy_open_and_close_epoch_preserved(self):
        one=self.close();two=self.close();self.assertEqual((one['epoch'],two['epoch']),(1,1))
        self.assertEqual(self.ok('open')['epoch'],1)
        self.assertEqual(self.close()['epoch'],2)

    def test_invalid_flags_versions_and_partial_cas_refuse_before_write(self):
        owned=self.close();before=self.marker.read_bytes()
        for args in [('open','--expected-epoch','1'),('open','--expected-revision',owned['revision']),
                     ('open','--expected-epoch','-1','--expected-revision',owned['revision']),
                     ('open','--expected-epoch','01','--expected-revision',owned['revision']),
                     ('open','--expected-epoch','true','--expected-revision',owned['revision']),
                     ('open','--expected-epoch','1','--expected-revision','not-a-revision'),
                     ('close','--expected-epoch','1'),('open','--unknown','value'),
                     ('status','extra'),('capabilities','--version','2'),
                     ('close','--allow'),('close','--allow','+21600000000')]:
            with self.subTest(args=args):
                self.assertEqual(self.run_owner(*args).returncode,2)
                self.assertEqual(self.marker.read_bytes(),before)

    def test_legacy_missing_revision_and_malformed_marker_never_admit_cas(self):
        owned=self.close()
        invalid=[{'state':'closed','epoch':1},None,[],{'state':'closed','epoch':True,'revision':owned['revision']},
                 {'state':'closed','epoch':1,'revision':123}, {'state':'other','epoch':1,'revision':owned['revision']}]
        for value in invalid:
            self.marker.write_text(json.dumps(value));before=self.marker.read_bytes()
            with self.subTest(value=value):
                self.assertNotEqual(self.run_owner(*self.open_args(owned)).returncode,0)
                self.assertEqual(self.marker.read_bytes(),before)

    def test_fifo_and_symlink_marker_cannot_read_other_file(self):
        owned=self.close();self.marker.unlink()
        foreign=self.home/'decoy';foreign.write_text('PRIVATE DECOY')
        self.marker.symlink_to(foreign)
        result=self.run_owner(*self.open_args(owned))
        self.assertNotEqual(result.returncode,0);self.assertNotIn('PRIVATE',result.stdout)
        self.assertEqual(foreign.read_text(),'PRIVATE DECOY')
        self.marker.unlink();os.mkfifo(self.marker)
        began=time.monotonic();result=self.run_owner(*self.open_args(owned))
        self.assertLess(time.monotonic()-began,1)
        self.assertNotEqual(result.returncode,0)

    def test_existing_maintenance_lock_serializes_compare_and_write(self):
        owned=self.close();before=self.marker.read_bytes()
        with (self.directory/'maintenance.lock').open('r+') as locked:
            fcntl.flock(locked,fcntl.LOCK_EX)
            result=self.run_owner(*self.open_args(owned))
        self.assertEqual((result.returncode,result.stderr.strip()),(3,'maintenance_marker_busy'))
        self.assertEqual(self.marker.read_bytes(),before)

    def test_lock_path_and_wait_validation_are_closed(self):
        self.close();lock=self.directory/'maintenance.lock';lock.unlink()
        decoy=self.home/'decoy';decoy.write_text('unchanged');lock.symlink_to(decoy)
        self.assertNotEqual(self.run_owner('close').returncode,0)
        self.assertEqual(decoy.read_text(),'unchanged')
        lock.unlink()
        for wait in ['-1','invalid','601','1.1']:
            self.assertEqual(self.run_owner('close',COMPANION_MAINTENANCE_LOCK_WAIT_S=wait).returncode,2)


if __name__=='__main__':unittest.main()
