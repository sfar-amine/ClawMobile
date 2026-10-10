"""O7 pure rendering/projection tests. Card cases are negative/shape controls, not S24 captures."""
import importlib.util,json,pathlib,unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fast',ROOT/'installer/termux-lite/model-fast-path.py');fast=importlib.util.module_from_spec(spec);spec.loader.exec_module(fast)
class DisplayTests(unittest.TestCase):
 def test_historical_real_receipt_generic_fallback(self):
  receipt=json.loads((ROOT/'openclaw-plugin-mobile-ui/fixtures/o7-historical/maxit-direct-live-results.json').read_text())
  self.assertTrue(receipt['private_values_omitted']);self.assertFalse(fast._display_text(receipt).lstrip().startswith(('{','[')))
 def test_cards_separate_not_summed(self):
  x={'data':{'cards':[{'title':'Internet','value':'2.500','unit':'GO','days_remaining':3},{'label':'Forfait','value':'7','unit':'Minutes','days_remaining':0}]}}
  text=fast._display_text(x);self.assertEqual(text.splitlines(),['Internet : 2.500 GO — validité restante : 3 jour(s)','Forfait : 7 Minutes — validité restante : 0 jour(s)']);self.assertNotIn('9.5',text)
 def test_closed_card_fields_no_account_payload(self):
  x={'data':{'cards':[{'title':'Compte','value':'3','unit':'TND','accountEmail':'owner@example.invalid','token':'private-value','raw':{'other':'private-value'}}]}}
  text=fast._display_text(x);self.assertEqual(text,'Compte : 3 TND');self.assertNotIn('@',text);self.assertNotIn('private-value',text)
 def test_every_fallback_is_readable_not_json(self):
  for value in [{},[],[{'x':'secret'}],{'text':' {"x":1}'},{'message':'[1,2]'},'{"x":1}',None,{'state':'needs_parameter','question':'[secret]'}]:
   with self.subTest(value=value):self.assertFalse(fast._display_text(value).lstrip().startswith(('{','[')))
 def test_card_count_and_fields_bounded(self):
  x={'cards':[{'title':'A'*1000,'value':'1','unit':'TND'} for _ in range(10000)]};text=fast._display_text(x);self.assertEqual(len(text.splitlines()),32);self.assertLess(len(text),4000)
 def test_invalid_card_values_not_exposed(self):
  for field in ['value','unit','title']:
   x={'title':'Compte','unit':'TND','value':'1'};x[field]='owner@example.invalid';self.assertNotIn('@',fast._display_text({'cards':[x]}))
 def test_network_provenance_closed_and_no_guard_values(self):
  for network in ['wifi_off','cellular_bind_wifi_on']:
   x=fast._execution_provenance({'capability':'orange.balance','route':'orange.balance.auto','extra':'ignored'}, {'result':{'network_guard':{'path':network,'SSID':'private-value'}}})
   self.assertEqual(x,{'capability':'orange.balance','route':'orange.balance.auto','network_path':network});self.assertLess(len(json.dumps(x)),400)
  self.assertNotIn('network_path',fast._execution_provenance({'capability':'orange.balance','route':'route'},{'network_path':'private-value'}))
 def test_real_fast_path_transports_projection(self):
  selected={'state':'ready','authorized':True,'deterministic':True,'model_required':False,'risk':'read','capability':'orange.balance','route':'orange.balance.auto'}
  resolved={'harness':{'tool_policy':'required'},'selected':selected}
  executed={**resolved,'execution':{'state':'completed','network_path':'wifi_off','result':{'data':{'cards':[{'title':'Internet','value':'2','unit':'GO'}]}}}}
  with mock.patch.object(fast,'resolve_capability',return_value=resolved),mock.patch.object(fast,'execute_capability',return_value=executed):
   out=fast.try_fast_path('test read')
  self.assertEqual(out['provenance'],{'capability':'orange.balance','route':'orange.balance.auto','network_path':'wifi_off'});self.assertEqual(out['text'],'Internet : 2 GO')
 def test_nested_composed_result_bounded(self):
  x={'text':'hello'}
  for _ in range(100):x={'ok':True,'strategy':'composed_read','results':[{'state':'completed','result':x}]}
  self.assertLess(len(fast._display_text(x)),1000)
 def test_composed_width_and_depth_total_bounded(self):
  x={'ok':True,'text':'x'*4000}
  for _ in range(10):x={'ok':True,'strategy':'composed_read','results':[{'state':'completed','result':x}]*32}
  self.assertLessEqual(len(fast._display_text(x)),8000)
 def test_provenance_ids_not_truncated_or_unbounded(self):
  for v in ['x'*161,'https://private.example','owner@example.invalid',None]:self.assertIsNone(fast._execution_provenance({'capability':'orange.balance','route':v},{}))
if __name__=='__main__':unittest.main()
