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
if __name__=='__main__':unittest.main()
