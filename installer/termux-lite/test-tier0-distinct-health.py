#!/usr/bin/env python3
"""Real S24 timeline plus offline state-machine replay, never a live deployment."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
CAPTURE=HERE.parent.parent/'openclaw-plugin-mobile-ui/fixtures/foundations/s24-tier0-soak-20261018.json'

class DistinctHealthSamples(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name)
        for relative in ('.openclaw/tier0','.openclaw/health','.openclaw/releases/old','.openclaw/releases/new'):
            (self.home/relative).mkdir(parents=True)
        releases=self.home/'.openclaw/releases'
        (releases/'last-known-good').symlink_to(releases/'old');(releases/'current').symlink_to(releases/'new')
        capture=json.loads(CAPTURE.read_text());self.grace=capture['soak_grace_until_epoch'];self.now=self.grace+16
        with patch.dict(os.environ,{'HOME':str(self.home)}):
            spec=importlib.util.spec_from_file_location('tier0_distinct_test',HERE/'tier0-watchdog.py')
            self.w=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.w)
        self.clock=patch.object(self.w.time,'time',side_effect=lambda:self.now);self.clock.start();self.addCleanup(self.clock.stop)
        self.rollback=patch.object(self.w.subprocess,'run').start();self.addCleanup(patch.stopall)
        patch.object(self.w.subprocess,'Popen').start()
        self.reset()

    def reset(self):
        self.w.STATE.write_text(json.dumps({'soak_state':'running','soak_deadline_epoch':self.now+300,
            'soak_grace_until_epoch':self.grace,'critical_capabilities':['gateway'],'soak_bad_samples':0}))

    def health(self,good=False,generated=None):
        value={'generated_at':self.now if generated is None else generated,
               'capabilities':{'gateway':{'state':'healthy' if good else 'down','reason':'PRIVATE_MARKER_NOT_FOR_LOGS'}}}
        self.w.HEALTH.write_text(json.dumps(value))

    def state(self):return json.loads(self.w.STATE.read_text())

    def test_same_bad_sample_is_counted_once_even_after_many_ticks(self):
        self.health(generated=self.grace+1)
        for _ in range(8):self.w.tick();self.now+=1
        self.assertEqual(self.state()['soak_bad_samples'],1)
        self.rollback.assert_not_called()

    def test_two_distinct_bad_samples_roll_back_and_preserve_the_evidence(self):
        self.health();self.w.tick();self.now+=15;self.health();self.w.tick()
        self.rollback.assert_called_once_with([str(self.w.CONTROL),'rollback','--reason','soak_health_regression'],check=True)
        evidence=self.state()['soak_last_health_sample']
        self.assertEqual(evidence['generated_at'],self.now)
        self.assertEqual(evidence['states'],{'gateway':'down'})
        line=(self.w.T/'watchdog.log').read_text()
        self.assertIn('soak_health_regression',line);self.assertNotIn('PRIVATE_MARKER',line)

    def test_healthy_sample_breaks_the_bad_sequence(self):
        self.health();self.w.tick();self.now+=15;self.health(True);self.w.tick()
        self.now+=15;self.health();self.w.tick()
        self.assertEqual(self.state()['soak_bad_samples'],1);self.rollback.assert_not_called()

    def test_restart_evidence_and_out_of_order_samples_do_not_count(self):
        self.health(generated=self.grace-1);self.w.tick();self.assertEqual(self.state()['soak_bad_samples'],0)
        self.health();self.w.tick();self.health(generated=self.now-1);self.w.tick()
        self.assertEqual(self.state()['soak_bad_samples'],1);self.rollback.assert_not_called()

    def test_missing_timestamp_cannot_mark_a_release_stable_and_has_a_deadline(self):
        self.w.HEALTH.write_text(json.dumps({'capabilities':{'gateway':{'state':'healthy'}}}))
        self.w.tick();self.rollback.assert_not_called();self.assertEqual(self.state()['soak_state'],'running')
        self.now=self.state()['soak_deadline_epoch']+1;self.w.tick()
        self.assertEqual(self.rollback.call_args.args[0][-1],'soak_health_evidence_unavailable')

    def test_malformed_health_schema_is_not_proof(self):
        self.w.HEALTH.write_text(json.dumps({'generated_at':self.now,'capabilities':[]}))
        self.w.tick();self.rollback.assert_not_called()
        self.assertEqual(self.state()['soak_state'],'running')

    def test_emergency_stop_prevents_rollback_even_when_evidence_expires(self):
        self.w.STOP.write_text('{"enabled":true}')
        self.w.HEALTH.write_text('{}');self.now=self.state()['soak_deadline_epoch']+1;self.w.tick()
        self.rollback.assert_not_called()

    def test_rollback_log_reuses_bounded_owner(self):
        log=self.w.T/'watchdog.log';log.write_text('x'*(300*1024))
        self.health();self.w.tick();self.now+=15;self.health();self.w.tick()
        self.assertLessEqual(log.stat().st_size,256*1024)
        self.assertLessEqual(log.with_name('watchdog.log.1').stat().st_size,256*1024)

    def test_five_soaks_with_a_transient_sample_and_recovery_do_not_roll_back(self):
        for _ in range(5):
            self.reset();self.health();self.w.tick();self.w.tick()
            self.now+=15;self.health(True);self.w.tick()
            self.now=self.state()['soak_deadline_epoch'];self.health(True);self.w.tick()
            self.assertEqual(self.state()['soak_state'],'stable')
            self.now+=1
        self.rollback.assert_not_called()

if __name__=='__main__':unittest.main()
