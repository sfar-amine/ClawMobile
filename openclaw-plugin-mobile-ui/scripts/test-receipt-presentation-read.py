import importlib.util
from pathlib import Path
import unittest
root=Path(__file__).resolve().parents[2]
def load(path,name):
 spec=importlib.util.spec_from_file_location(name,path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
reader=load(root/'installer/termux-lite/receipt-presentation-read.py','hs3read')
fast=load(root/'installer/termux-lite/model-fast-path.py','hs3fast')
def metadata():
 return {'version':1,'locale':'fr','status':'error','label':'Demande','title':'Résultat à vérifier','rows':[],'spoken':'La demande n’a pas abouti.','primary':{'label':'Terminer','action':'done'},'effect':{'debited':'unknown','source':'receipt'},'meta':{'capability':None},'understood':{'capability':None,'label':'Demande','slots':{}},'alternatives':[],'failure':{'step':'Étape non établie','reason':'La cause n’est pas établie.'}}
class ReaderTests(unittest.TestCase):
 def test_valid_generated_contract_metadata_prefers_presentation(self):
  p=metadata();raw={'presentation':p,'text':'legacy'}
  self.assertEqual(fast._display_text(raw),p['title']+'\n'+p['spoken'])
 def test_private_fields_removed_and_no_payment_truth_inferred(self):
  p=metadata();p['nonce']='private';p['understood']['slots']['amount']=10
  self.assertNotIn('nonce',str(reader.read({'presentation':p})));self.assertNotIn('amount',str(reader.read({'presentation':p})))
  for effect in (False,True,[],{}):
   p['effect']['debited']=effect;self.assertIsNone(reader.read({'presentation':p}))
 def test_malformed_types_and_private_text_rejected(self):
  for raw in ({},[],{'presentation':[]},{'presentation':{'version':1}}):self.assertIsNone(reader.read(raw))
  for value in ('Bearer abcdefghijklmnop','ghp_abcdefghijklmnop','Contact 99 123 456'):
   p=metadata();p['label']=value;self.assertIsNone(reader.read({'presentation':p}))
 def test_legacy_fallback_unchanged_without_validated_presentation(self):
  self.assertEqual(fast._display_text({'text':'legacy'}),'legacy')
  self.assertEqual(fast._display_text({'presentation':{},'text':'legacy'}),'legacy')

import json
CAPTURES=root/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11c/hs3-presentations-from-captures.json'
class CaptureTests(unittest.TestCase):
 """Graph presentations computed on real cleaned S24 captures (s24-2026-10-11, s24-2026-10-11c)."""
 def setUp(self):self.cases=json.loads(CAPTURES.read_text(encoding='utf-8'))['cases']
 def test_every_capture_presentation_passes_closed_reader_unchanged(self):
  for name,case in self.cases.items():
   got=reader.read({'presentation':case['presentation']})
   self.assertIsNotNone(got,name);self.assertEqual(got['presentation'],case['presentation'],name)
   self.assertEqual(got['presentation']['effect']['debited'],'unknown')
 def test_topup_understood_line_reaches_display_text(self):
  raw={'presentation':self.cases['topup_confirmation_fr']['presentation']}
  self.assertTrue(fast._display_text(raw).startswith('Compris : Recharger mon numéro · Orange · 5 DT · ta ligne'))
  self.assertEqual(reader.read(raw)['understood']['slots'],{'operator':'orange','amountTnd':'5','beneficiary':'owner'})
 def test_not_done_only_when_proven(self):
  self.assertEqual(reader.read({'presentation':self.cases['payment_expired_not_submitted_fr']['presentation']})['failure']['notDone']['code'],'payment_not_submitted')
  for name in ('payment_effect_unknown_fr','payment_blocked_after_dispatch_fr'):
   f=reader.read({'presentation':self.cases[name]['presentation']})['failure']
   self.assertEqual(f['notDone'],{'code':'unknown'});self.assertEqual(f['stepId'],'execution_error')
 def test_forged_slots_and_not_done_dropped(self):
  p=json.loads(json.dumps(self.cases['payment_effect_unknown_fr']['presentation']))
  p['understood']['slots']={'amountTnd':'99999999','beneficiary':'+21600000001','operator':'other'}
  p['failure']['notDone']={'code':'nothing_debited','text':'Rien n’a été débité.'};p['failure']['stepId']='made_up'
  got=reader.read({'presentation':p})
  self.assertEqual(got['understood']['slots'],{});self.assertNotIn('notDone',got['failure']);self.assertNotIn('stepId',got['failure'])
if __name__=='__main__':unittest.main()
