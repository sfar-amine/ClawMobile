#!/usr/bin/env python3
"""Real metadata timeline plus explicit offline lifecycle tests; no S24 mutation or model call."""
import importlib.util,json,os,sys,tempfile,unittest,signal,contextlib,fcntl
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
CAPTURE=HERE.parent.parent/'openclaw-plugin-mobile-ui/fixtures/foundations/s24-tier0-activation-20261025.json'

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class ActivationReadiness(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name)
        with patch.dict(os.environ,{'HOME':str(self.home)}):self.c=module('tier0_ready_test','tier0-control.py')
        self.capture=json.loads(CAPTURE.read_text());self.clock=self.capture['promoted_at']
        self.target=self.c.RELEASES/self.capture['candidate'];(self.target/'termux-lite').mkdir(parents=True)
        self.old=self.c.RELEASES/'old';self.old.mkdir();self.c.CURRENT.symlink_to(self.old)
        self.c.TIER0.mkdir(parents=True);self.c.HEALTH.parent.mkdir(parents=True)
        self.c.STATE.write_text(json.dumps({'current':'old'}))
        self.meta={'soak_seconds':300,'startup_grace_seconds':30,'critical_capabilities':list(self.capture['last_health_states'])}
        self.args=SimpleNamespace(release_id=self.target.name)
        patch.object(self.c.runtime_mode,'current_mode',return_value='normal').start()
        patch.object(self.c,'verify_release',return_value=self.meta).start()
        self.activate_patch=patch.object(self.c,'activate_current');self.activate=self.activate_patch.start()
        patch.object(self.c.time,'time',side_effect=lambda:self.clock).start()
        patch.object(self.c.time,'monotonic',side_effect=lambda:self.clock).start()
        patch.object(self.c.time,'sleep',side_effect=lambda dt:setattr(self,'clock',self.clock+dt)).start()
        self.addCleanup(patch.stopall)
    def health(self,*,states=None,root=None,stamp=None):
        # A hypothetical post-activation sample is constructed only for unit replay, never committed as LIVE evidence.
        self.c.HEALTH.write_text(json.dumps({'generated_at':int(self.clock) if stamp is None else stamp,
            'runtime_root':str((self.target/'termux-lite').resolve()) if root is None else root,
            'capabilities':{k:{'state':v} for k,v in (states or {k:'healthy' for k in self.meta['critical_capabilities']}).items()}}))
    def test_real_timeline_exposes_sample_before_worker_ready_not_a_proven_crash(self):
        v=self.capture
        self.assertLess(v['soak_grace_until_epoch'],v['last_health_generated_at'])
        self.assertLess(v['last_health_generated_at'],v['orchestrator_start_ok_at'])
        self.assertFalse(v['worker_crash_proven']);self.assertFalse(v['two_distinct_pre_rollback_samples_captured'])
        self.assertLess(v['resident_watchdog']['started_at'],v['resident_watchdog']['installed_source_mtime'])
        self.assertFalse(v['tier0_bin_immune_action_exists'])
    def test_promotion_starts_activation_and_never_arms_soak_before_native_readiness(self):
        pending=self.c.cmd_promote(self.args)
        self.assertEqual(pending['soak_state'],'activating');self.assertNotIn('soak_deadline_epoch',pending)
        self.activate.assert_called_once()
        self.clock=self.capture['last_health_generated_at']
        self.health(states=self.capture['last_health_states'])
        self.assertIsNone(self.c.activation_health_sample(pending,self.target,self.clock))
        self.assertEqual(json.loads(self.c.STATE.read_text())['soak_state'],'activating')
    def test_fresh_correct_release_all_critical_ready_starts_full_unchanged_soak(self):
        pending=self.c.cmd_promote(self.args);self.clock=self.capture['orchestrator_start_ok_at']+6;self.health()
        result=self.c.finish_promotion(self.args,pending)
        self.assertEqual(result['soak_state'],'running')
        self.assertEqual(result['soak_deadline_epoch'],int(self.clock)+300)
        self.assertEqual(result['soak_grace_until_epoch'],int(self.clock)+30)
        self.assertEqual(set(result['activation_health_sample']['states']),set(self.meta['critical_capabilities']))
    def test_old_unknown_future_or_wrong_runtime_sample_cannot_authorize_soak(self):
        pending=self.c.cmd_promote(self.args)
        for options in ({'stamp':self.clock-1},{'stamp':self.clock+1},{'stamp':True},{'root':str(self.old/'termux-lite')},{'root':''}):
            self.health(**options);self.assertIsNone(self.c.activation_health_sample(pending,self.target,self.clock))
        self.health();v=json.loads(self.c.HEALTH.read_text());v.pop('runtime_root');self.c.HEALTH.write_text(json.dumps(v))
        self.assertIsNone(self.c.activation_health_sample(pending,self.target,self.clock))
    def test_failed_readiness_has_a_bound_and_never_marks_stable_or_running(self):
        pending=self.c.cmd_promote(self.args);self.health(states=self.capture['last_health_states'])
        with self.assertRaisesRegex(SystemExit,'activation_readiness_failed'):self.c.finish_promotion(self.args,pending)
        failed=json.loads(self.c.STATE.read_text());self.assertEqual(failed['soak_state'],'activation_failed')
        self.assertNotIn('soak_deadline_epoch',failed);self.assertLessEqual(self.clock-self.capture['promoted_at'],120)
    def test_same_target_retry_never_restarts_or_rearms_the_owner(self):
        pending=self.c.cmd_promote(self.args);again=self.c.cmd_promote(self.args)
        self.assertEqual(again,pending);self.activate.assert_called_once()
        self.clock+=1;self.health();result=self.c.finish_promotion(self.args,pending)
        self.assertEqual(self.c.cmd_promote(self.args),result);self.activate.assert_called_once()
    def test_intervening_rollback_never_gets_overwritten_by_pending_activation(self):
        pending=self.c.cmd_promote(self.args);self.health();self.c.CURRENT.unlink();self.c.CURRENT.symlink_to(self.old)
        with self.assertRaisesRegex(SystemExit,'activation_target_changed'):self.c.finish_promotion(self.args,pending)
    def test_emergency_stop_cannot_become_readiness_success(self):
        pending=self.c.cmd_promote(self.args);self.health();self.c.STOP.write_text('{"enabled":true}')
        with self.assertRaisesRegex(SystemExit,'emergency_stop_active'):self.c.finish_promotion(self.args,pending)
        self.assertEqual(json.loads(self.c.STATE.read_text())['soak_state'],'activating')
    def test_detached_activation_closes_transient_lock_authority_but_preserves_parent(self):
        self.activate_patch.stop() # Exercise the real owner, not the bootstrap stub used by other lifecycle cases.
        boot=self.c.TIER0/'bin/tier0-bootstrap.sh';boot.parent.mkdir();boot.write_text('#!/bin/sh\n')
        with patch.dict(os.environ,{'SAMANTHA_DEPLOY_LOCK_FD':'9','SAMANTHA_DEPLOY_LOCK_WAIT_S':'0','TIER0_TEST_KEEP':'kept'}),patch.object(self.c.subprocess,'Popen') as child:
            self.c.activate_current()
            args,options=child.call_args
            self.assertTrue(options['close_fds']);self.assertTrue(options['start_new_session'])
            self.assertNotIn('SAMANTHA_DEPLOY_LOCK_FD',options['env'])
            self.assertNotIn('SAMANTHA_DEPLOY_LOCK_WAIT_S',options['env'])
            self.assertEqual(options['env']['TIER0_TEST_KEEP'],'kept')
            self.assertEqual(options.get('pass_fds',()),())
            self.assertEqual(os.environ['SAMANTHA_DEPLOY_LOCK_FD'],'9')
    def test_main_releases_control_lock_before_readiness_wait(self):
        def prepare(_args):
            with open(self.c.TIER0/'control.lock','a') as independent:
                with self.assertRaises(BlockingIOError):fcntl.flock(independent,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return {'soak_state':'activating'}
        def finish(_args,_pending):
            with open(self.c.TIER0/'control.lock','a') as independent:
                fcntl.flock(independent,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return {'soak_state':'running'}
        with patch.object(sys,'argv',['tier0-control.py','promote',self.target.name]),patch.object(self.c.runtime_mode,'deployment_guard',return_value=contextlib.nullcontext()),patch.object(self.c,'cmd_promote',side_effect=prepare),patch.object(self.c,'finish_promotion',side_effect=finish),patch('builtins.print'):
            self.c.main()

class WatchdogReload(unittest.TestCase):
    def setUp(self):self.m=module('tier0_installer_test','install-tier0-control.py')
    def test_installer_closes_the_versioned_ai_dependency_set_before_reload(self):
        self.assertIn('immune_action.py',self.m.NAMES)
        source=(HERE/'install-tier0-control.py').read_text()
        self.assertLess(source.index("if not (Path(a.source_root)/n).is_file()"),source.index("shutil.copy2(src,tmp)"))
        self.assertLess(source.index("shutil.copy2(src,tmp)"),source.index('reload_watchdog(resident)'))
    def test_recycled_pid_or_different_argv_is_never_signalled(self):
        with patch.object(self.m,'watchdog_has_children',return_value=False),patch.object(self.m,'watchdog_identity',return_value='new-start'),patch.object(self.m.os,'kill') as kill:
            self.m.reload_watchdog({71:'old-start'});kill.assert_not_called()
    def test_existing_owner_with_pending_child_is_preserved_as_uncertain(self):
        with patch.object(self.m,'watchdog_has_children',return_value=True),patch.object(self.m.os,'kill') as kill:
            with self.assertRaisesRegex(RuntimeError,'watchdog_busy_no_reload'):self.m.reload_watchdog({71:'old-start'})
            kill.assert_not_called()
    def test_verified_old_interpreter_is_stopped_once_without_killing_reused_pid(self):
        values=iter(['old-start',None,None]);native=lambda _pid:next(values,None)
        with patch.object(self.m,'watchdog_has_children',return_value=False),patch.object(self.m,'watchdog_identity',side_effect=native),patch.object(self.m.os,'kill') as kill:
            self.m.reload_watchdog({71:'old-start'});kill.assert_called_once_with(71,signal.SIGTERM)
    def test_watchdog_singleton_reuses_the_existing_tier0_owner(self):
        with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'HOME':root}):
            w=module('tier0_watchdog_singleton_test','tier0-watchdog.py')
            with patch.object(w.fcntl,'flock',side_effect=BlockingIOError),patch.object(w,'tick') as tick:
                w.main();tick.assert_not_called()
            self.assertTrue((w.T/'watchdog.lock').is_file())

if __name__=='__main__':unittest.main()
