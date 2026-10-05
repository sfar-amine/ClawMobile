#!/data/data/com.termux/files/usr/bin/python3
import importlib.util, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('rdc',ROOT/'remote-desktop-control.py')
rdc=importlib.util.module_from_spec(spec);spec.loader.exec_module(rdc)

class HealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name);self.proc=self.home/'proc'
        (self.proc/'sys/kernel/random').mkdir(parents=True)
        (self.proc/'sys/kernel/random/boot_id').write_text('boot-a')
        self.pid=123;self.add_process(self.pid)
        self.folder=self.home/'.openclaw/watchdogs';self.folder.mkdir(parents=True)
        self.receipt={'pid':123,'start_ticks':'100','boot_id':'boot-a','checked_at':990,
            'local_mcp':True,'remote_channel':True,'healthy':True}
        self.write()
    def add_process(self,pid):
        p=self.proc/str(pid);p.mkdir()
        fields=['S','1']+['0']*17+['100']
        (p/'stat').write_text(str(pid)+' (node) '+' '.join(fields))
        (p/'cmdline').write_bytes(('node\0'+rdc.SCRIPT+'\0remote\0').encode())
        (p/'environ').write_bytes(('SHELL='+str(rdc.ROOT/'remote-desktop-bash')+'\0').encode())
    def write(self): (self.folder/'remote-desktop-123.json').write_text(json.dumps(self.receipt))
    def probe(self): return rdc.health(self.home,self.proc,1000)
    def test_singleton_with_both_proofs(self): self.assertEqual(self.probe()['state'],'healthy')
    def test_duplicate_is_never_healthy(self):
        self.add_process(456);self.assertEqual(self.probe()['reason'],'duplicate_instances')
    def test_missing_receipt_is_not_health(self):
        (self.folder/'remote-desktop-123.json').unlink();self.assertEqual(self.probe()['state'],'unverified')
    def test_stale_and_future_receipts_rejected(self):
        for ts in [900,1001]:
            self.receipt['checked_at']=ts;self.write();self.assertEqual(self.probe()['reason'],'functional_receipt_stale')
    def test_pid_reuse_and_reboot_rejected(self):
        for key,value in [('start_ticks','99'),('boot_id','old'),('pid',999)]:
            with self.subTest(key=key):
                before=self.receipt[key];self.receipt[key]=value;self.write()
                self.assertEqual(self.probe()['reason'],'receipt_identity_mismatch');self.receipt[key]=before
    def test_each_functional_layer_required(self):
        for key in ['local_mcp','remote_channel','healthy']:
            self.receipt[key]=False;self.write();self.assertNotEqual(self.probe()['state'],'healthy');self.receipt[key]=True
    def test_process_args_are_exact(self):
        (self.proc/'123/cmdline').write_text('bash\0-c\0echo '+rdc.SCRIPT+' remote\0')
        self.assertEqual(self.probe()['reason'],'process_missing')
    def test_stale_runtime_shell_is_not_healthy(self):
        (self.proc/'123/environ').write_bytes(b'SHELL=/data/data/com.termux/files/usr/bin/bash\0')
        self.assertEqual(self.probe()['reason'],'runtime_environment_stale')


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.c=rdc.Controller(self.tmp.name);self.events=[];self.running=False
    def stop(self): self.events.append('stop');self.running=False;return True
    def launch(self):
        self.assertFalse(self.running,'retry started before previous process stopped')
        self.events.append('launch');self.running=True
    def test_slow_first_attempt_cannot_create_duplicate(self):
        with patch.object(self.c,'stop',side_effect=self.stop),patch.object(self.c,'launch',side_effect=self.launch),patch.object(self.c,'wait_ready',side_effect=[False,True]),patch.object(self.c,'probe',side_effect=[{'state':'degraded'},{'state':'healthy'}]):
            self.assertEqual(self.c.repair()['state'],'recovered')
        self.assertEqual(self.events,['stop','launch','stop','stop','launch'])
    def test_exhausted_attempt_is_cleaned(self):
        with patch.object(self.c,'stop',side_effect=self.stop),patch.object(self.c,'launch',side_effect=self.launch),patch.object(self.c,'wait_ready',return_value=False):
            self.assertEqual(self.c.repair()['state'],'failed')
        self.assertFalse(self.running);self.assertEqual(self.events.count('launch'),2)
    def test_launch_preserves_preload_argument_in_android_wrapper(self):
        with patch.object(rdc.subprocess,'Popen') as popen:
            self.c.launch()
        args=popen.call_args.args[0]
        self.assertEqual(sum(a.startswith('--import=') for a in args),1)
        self.assertNotIn('--import',args)
        self.assertTrue(popen.call_args.kwargs['close_fds'])
        expected=str(self.c.home/'.cache/tmp')
        env=popen.call_args.kwargs['env']
        self.assertEqual(env['TMPDIR'],expected)
        self.assertEqual(env['TMP'],expected)
        self.assertEqual(env['TEMP'],expected)
        self.assertEqual(env['SHELL'],str(self.c.root/'remote-desktop-bash'))
        self.assertTrue((self.c.home/'.cache/tmp').is_dir())
    def test_verified_recovery_does_not_replay_restart(self):
        with patch.object(self.c,'probe',return_value={'state':'healthy'}),patch.object(self.c,'launch') as launch:
            self.assertEqual(self.c.repair()['mutation'],'none_already_healthy');launch.assert_not_called()
    def test_stop_failure_forbids_launch(self):
        with patch.object(self.c,'stop',return_value=False),patch.object(self.c,'launch') as launch:
            self.assertEqual(self.c.repair()['reason'],'previous_instance_survived');launch.assert_not_called()
    def test_concurrent_owners_cannot_restart(self):
        with self.c.lock('remote-desktop-repair.lock') as held,patch.object(self.c,'launch') as launch:
            self.assertTrue(held);self.assertEqual(self.c.repair()['state'],'busy');launch.assert_not_called()
    def test_readiness_is_bounded_and_requires_consecutive_proofs(self):
        self.c.readiness=4
        with patch.object(self.c,'beat'),patch.object(self.c,'probe',side_effect=[{'state':'degraded','reason':'local_mcp_unresponsive'},{'state':'healthy','reason':'ok'},{'state':'healthy','reason':'ok'}]),patch.object(rdc.time,'sleep'):
            self.assertTrue(self.c.wait_ready())
    def test_half_open_defers_without_restart_while_dependency_is_unreachable(self):
        c=rdc.Controller(self.tmp.name,dependency_probe=lambda:False)
        with patch.object(c,'repair') as repair:
            self.assertEqual(c.half_open(),{'state':'deferred','reason':'remote_dependency_unreachable'})
            repair.assert_not_called()
    def test_half_open_reuses_bounded_repair_after_dependency_returns(self):
        c=rdc.Controller(self.tmp.name,dependency_probe=lambda:True)
        with patch.object(c,'repair',return_value={'state':'recovered','evidence':{'state':'healthy'}}) as repair:
            self.assertEqual(c.half_open()['state'],'recovered')
            repair.assert_called_once_with()

if __name__=='__main__':unittest.main(verbosity=2)
