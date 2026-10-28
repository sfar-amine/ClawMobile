import copy,datetime as dt,importlib.util,json,sys,tempfile,unittest,unittest.mock
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
hook=load('nightly_dialogue_replay','nightly-dialogue-replay.py')
nightly=load('nightly','companion-nightly-acceptance.py')
# Output of `python -m skill_intelligence.dialogue.replay` at ui-playbooks 06e41a81 (verdicts dropped by the hook).
REPORT={"corpus":"owner-typed-v1","cases":6,"failed":[],"seconds":1.5,"unnamedFailures":[],"state":"passed"}
ACCEPTANCE=json.loads((ROOT.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/h8/acceptance-receipts.json').read_text())['samples'][0]['acceptance']
NOW=dt.datetime(2026,10,29,2,0,tzinfo=dt.timezone.utc)

def runtime(home,sha='06e41a81dcc4bbdff825b1edd216d068b5ff5f77'):
 snap=Path(home)/'.openclaw/runtime-ui-playbooks'/sha;(snap/'skill_intelligence/dialogue').mkdir(parents=True)
 (snap/'skill_intelligence/dialogue/replay.py').write_text('');(Path(home)/'.openclaw/runtime-ui-playbooks/current').symlink_to(snap)
 return snap

class NightlyDialogueReplayTests(unittest.TestCase):
 def run_nightly(self,home,report,code=0):
  calls=[]
  def runner(cmd,timeout):
   calls.append(cmd)
   if cmd[1:2]==['-c']:return code,copy.deepcopy(report)
   return 0,copy.deepcopy(ACCEPTANCE)
  state=Path(home)/'.openclaw/deploys'
  with unittest.mock.patch.object(nightly.runtime_mode,'current_mode',return_value='normal'):
   out,rc=nightly.execute(state,ROOT,NOW,runner=runner,notifier=lambda:None,preflight=lambda:True,home=home)
  return out,rc,json.loads((state/out['receipt']).read_text()),calls

 def test_replay_runs_from_the_active_snapshot_and_its_verdict_is_kept(self):
  with tempfile.TemporaryDirectory() as home:
   snap=runtime(home)
   out,rc,receipt,calls=self.run_nightly(home,REPORT)
   replay=receipt['dialogueReplay']
   self.assertEqual((replay['state'],replay['cases'],replay['revision']),('passed',6,snap.name))
   self.assertNotIn('verdicts',replay)
   self.assertEqual(calls[-1][-1],str(snap.resolve()))

 def test_failed_replay_fails_the_night_and_unnamed_causes_ask_attention(self):
  with tempfile.TemporaryDirectory() as home:
   runtime(home)
   failed={**REPORT,'state':'failed','failed':['pulse-create-slow']}
   out,rc,receipt,_=self.run_nightly(home,failed,code=1)
   self.assertEqual((receipt['state'],rc),('failed',1))
  with tempfile.TemporaryDirectory() as home:
   runtime(home)
   attention={**REPORT,'state':'attention','unnamedFailures':['brand_new_cause']}
   out,rc,receipt,_=self.run_nightly(home,attention)
   self.assertEqual(receipt['dialogueReplay']['unnamedFailures'],['brand_new_cause'])
   self.assertIn(receipt['state'],('attention','failed'))

 def test_no_snapshot_with_replay_is_not_configured_and_changes_nothing(self):
  with tempfile.TemporaryDirectory() as home:
   section,attention,failed=hook.execute_replay(home,lambda *a:self.fail('no run'))
   self.assertEqual((section,attention,failed),({'state':'not_configured'},False,False))

 def test_open_or_oversized_reports_are_refused(self):
  for raw in ({**REPORT,'state':'ok'},{**REPORT,'failed':['x'*200]},{**REPORT,'unnamedFailures':['a b']},
              {**REPORT,'cases':True},[]):
   with self.subTest(raw=str(raw)[:60]),self.assertRaises(ValueError):hook.closed_report(raw)
  with tempfile.TemporaryDirectory() as home:
   runtime(home)
   section,attention,failed=hook.execute_replay(home,lambda *a:(0,{'state':'ok'}))
   self.assertEqual((section['state'],attention,failed),('unavailable',True,False))

if __name__=='__main__':
 unittest.main()
