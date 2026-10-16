import subprocess
import tempfile
from pathlib import Path
import unittest

SCRIPT=Path(__file__).with_name('samantha-health-manager.sh')

class ManagerExpiryTests(unittest.TestCase):
    def functions(self):
        text=SCRIPT.read_text();return text[text.index('# R17 runs cooperatively'):text.index("log 'event=start result=ok state=persistent_backoff'")]
    def execute(self, prefix, body):
        with tempfile.TemporaryDirectory() as root:
            script='TRACE='+repr(root+'/trace')+'\n'+prefix+'\n'+self.functions()+'\n'+body
            result=subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            file=Path(root)/'trace';return file.read_text().splitlines() if file.exists() else []
    def test_cooperative_grace_keeps_minute_cadence_without_disk_write(self):
        prefix='''CLOCK=100;ROOT=/fixture;PROCESSED=0
now(){ printf '%s' "$CLOCK"; }
get(){ printf 0; }
put(){ printf 'WRITE %s %s %s\n' "$1" "$2" "$3" >>"$TRACE"; }
log(){ :; }
sleep(){ CLOCK=$((CLOCK+$1)); }
timeout(){ printf 'SCAN %s\n' "$CLOCK" >>"$TRACE"; printf '{"processed":%s}' "$PROCESSED"; }
'''
        trace=self.execute(prefix,'check_allowlist_expiry; sleep 60; check_allowlist_expiry; sleep 60; check_allowlist_expiry')
        self.assertEqual(trace,['SCAN 100','SCAN 160','SCAN 220'])
    def test_due_expiry_persists_same_owner_state_and_restart_cadence(self):
        prefix='''CLOCK=200;ROOT=/fixture;PROCESSED=1
now(){ printf '%s' "$CLOCK"; }
get(){ printf 170; }
put(){ printf 'WRITE %s %s %s\n' "$1" "$2" "$3" >>"$TRACE"; }
log(){ :; }
sleep(){ CLOCK=$((CLOCK+$1)); }
timeout(){ printf 'SCAN %s\n' "$CLOCK" >>"$TRACE"; printf '{"processed":%s}' "$PROCESSED"; }
'''
        trace=self.execute(prefix,'check_allowlist_expiry; sleep 35; check_allowlist_expiry')
        self.assertEqual(trace,['SCAN 235','WRITE whatsapp_allowlist last_sweep 235'])
    def test_existing_cycle_has_checkpoints_and_closed_lock_child(self):
        text=SCRIPT.read_text();loop=text[text.index("log 'event=start result=ok state=persistent_backoff'"):]
        self.assertIn('check_allowlist_expiry\n check_smtp',loop)
        self.assertIn('check_allowlist_expiry\n check_http companion',loop)
        self.assertIn('sleep "$grace"',text)
        self.assertNotIn('allowlist_sleep',text)
        self.assertNotIn('timeout --kill-after=2 20',text)
        self.assertIn('sleep 1',text)
        self.assertIn('timeout --kill-after=2 22 python3 "$ROOT/people-trusted.py" allowlist sweep 9>&-',text)
        self.assertNotIn('nohup',self.functions())

    def test_forget_counts_logged_without_personal_content(self):
        prefix='''CLOCK=100;ROOT=/fixture
now(){ printf '%s' "$CLOCK"; }
get(){ printf 0; }
put(){ printf 'WRITE %s %s %s\\n' "$1" "$2" "$3" >>"$TRACE"; }
log(){ printf 'LOG %s\\n' "$1" >>"$TRACE"; }
timeout(){ printf '{"processed":0,"forget":{"state":"partial","forgotten":2,"remaining":1}}'; }
'''
        trace=self.execute(prefix,'check_allowlist_expiry')
        self.assertEqual(trace,['LOG service=whatsapp_allowlist event=forget forgotten=2 remaining=1'])
        idle=prefix.replace('"forgotten":2','"forgotten":0')
        self.assertEqual(self.execute(idle,'check_allowlist_expiry'),[])

if __name__=='__main__':unittest.main()
