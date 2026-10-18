"""Execute the real health-manager hook against bounded synthetic owner fixtures."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parent
MANAGER=ROOT/'samantha-health-manager.sh'
SENTINEL='SYNTHETIC_PRIVATE_CONTACT_BODY_MUST_NOT_LOG'

class HealthQaQueueTests(unittest.TestCase):
    def probe(self,code,*,mode='normal',calls=1,timeout=5):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);runtime=home/'runtime';runtime.mkdir();(home/'.cache/tmp').mkdir(parents=True)
            helper=runtime/'people-trusted.py'
            helper.write_text('import json,os,sys,time\nfrom pathlib import Path\n'
                'assert sys.argv[1:]==["qa-queue-tick"]\n'
                'p=Path.home()/"calls";p.write_text(p.read_text()+"1" if p.exists() else "1")\n'
                'try:os.fstat(9);raise AssertionError("health lock inherited")\n'
                'except OSError:pass\n'+code)
            source=MANAGER.read_text();prefix=source.split("log 'event=start",1)[0]
            self.assertIn('check_qa_queue(){',prefix)
            script=home/'probe.sh';script.write_text(prefix+
                '\ncanonical_mode(){ printf "%s" "'+mode+'"; }\n'
                'log(){ printf "%s\\n" "$*" >>"$HOME/observed.log"; }\n'+
                '\n'.join('check_qa_queue' for _ in range(calls))+'\n')
            env={**os.environ,'HOME':str(home),'CLAW_RUNTIME_ROOT':str(runtime)}
            began=time.monotonic()
            result=subprocess.run(['bash',str(script)],env=env,capture_output=True,text=True,timeout=timeout)
            elapsed=time.monotonic()-began
            self.assertEqual(result.returncode,0)
            self.assertNotIn(SENTINEL,result.stdout+result.stderr)
            log=(home/'observed.log').read_text() if (home/'observed.log').exists() else ''
            count=len((home/'calls').read_text()) if (home/'calls').exists() else 0
            return log,count,elapsed
    def test_pending_returns_closed_state_and_quiet_on_unchanged_tick(self):
        log,count,_=self.probe('print(json.dumps({"state":"NOT_READY","dispatched":0,"waiting":0}))',calls=2)
        self.assertEqual(count,2);self.assertEqual(log.count('service=qa_queue'),1)
        self.assertIn('state=NOT_READY dispatched=0 waiting=0',log)
    def test_skip_non_normal_and_emergency_stop_before_private_owner(self):
        for mode in ['emergency_stop','unknown','deploying','repairing']:
            with self.subTest(mode=mode):
                log,count,_=self.probe('raise AssertionError("must not execute")',mode=mode)
                self.assertEqual(count,0);self.assertEqual(log,'')
    def test_one_owner_tick_never_publishes_private_fields_or_raw_errors(self):
        code='print(json.dumps({"state":"STARTED","dispatched":1,"waiting":2}))'
        log,count,_=self.probe(code)
        self.assertEqual(count,1);self.assertEqual(log.strip(),'service=qa_queue state=STARTED dispatched=1 waiting=2')
        variants=[{'state':'STARTED','dispatched':2,'waiting':0},
            {'state':'IDLE','dispatched':1,'waiting':0},{'state':'WAITING','dispatched':False,'waiting':1},
            {'state':'WAITING','dispatched':0,'waiting':501},
            {'state':SENTINEL,'dispatched':0,'waiting':0},
            {'state':'IDLE','dispatched':0,'waiting':0,'contact':SENTINEL}]
        for value in variants:
            with self.subTest(value=value):
                log,_,_=self.probe('print('+repr(json.dumps(value))+')')
                self.assertNotIn(SENTINEL,log);self.assertIn('state=UNAVAILABLE dispatched=0 waiting=0',log)
    def test_large_or_failed_helper_is_bounded_and_does_not_retry(self):
        for code in ['print("x"*7000+"'+SENTINEL+'")',
                     'print("'+SENTINEL+'",file=sys.stderr);sys.exit(7)']:
            log,count,elapsed=self.probe(code)
            self.assertEqual(count,1);self.assertNotIn(SENTINEL,log)
            self.assertIn('state=UNAVAILABLE dispatched=0 waiting=0',log);self.assertLess(elapsed,3)
    def test_real_timeout_stops_one_blocked_owner_within_budget(self):
        log,count,elapsed=self.probe('time.sleep(60)',timeout=18)
        self.assertEqual(count,1);self.assertIn('state=UNAVAILABLE dispatched=0 waiting=0',log)
        self.assertLess(elapsed,16) # real timeout14s + maximum1s kill grace, allow scheduling overhead
    def test_hook_uses_current_health_cycle_and_fixed_owner_command(self):
        source=MANAGER.read_text();loop=source.split("log 'event=start",1)[1]
        self.assertEqual(loop.count('\n check_qa_queue\n'),1)
        self.assertIn('timeout --kill-after=1 14 python3 "$ROOT/people-trusted.py" qa-queue-tick 9>&-',source)
        self.assertNotIn('qa-queue-tick &',source)

if __name__=='__main__':unittest.main()
