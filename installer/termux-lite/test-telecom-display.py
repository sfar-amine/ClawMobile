"""O7 rendering/projection tests.

The nominal case is the real S24 capture of the 10/10 09:41 "Mon solde Orange" run (8 cards, values replaced by
format-preserving substitutes, titles/units/validity real): fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json.
Remaining card dicts are explicit negative mutations (privacy, bounds), not captures."""
import importlib.util,json,pathlib,unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fast',ROOT/'installer/termux-lite/model-fast-path.py');fast=importlib.util.module_from_spec(spec);spec.loader.exec_module(fast)
CAPTURE=json.loads((ROOT/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json').read_text(encoding='utf-8'))
class DisplayTests(unittest.TestCase):
 def test_historical_real_receipt_generic_fallback(self):
  receipt=json.loads((ROOT/'openclaw-plugin-mobile-ui/fixtures/o7-historical/maxit-direct-live-results.json').read_text())
  self.assertTrue(receipt['private_values_omitted']);self.assertFalse(fast._display_text(receipt).lstrip().startswith(('{','[')))
 def test_real_capture_one_card_per_line_with_value_unit_validity(self):
  result=CAPTURE['client_received_result'];cards=result['data']['cards']
  self.assertEqual(len(cards),8)
  text=fast._display_text(result)
  self.assertEqual(text.splitlines(),[
   'Bonus internet mobile : 9.49 GO — validité restante : 21 jour(s)',
   'Forfait du mois en cours : 13 TND — validité restante : 51 jour(s)',
   'Compte de recharge : 34.084 TND — validité restante : 4100 jour(s)',
   'Report du forfait : 22.473 TND — validité restante : 51 jour(s)',
   'Option sur forfait Internet Mobile : 21.74 GO — validité restante : 21 jour(s)',
   'Navigui 500Go (365j) : 68.42 GO — validité restante : 313 jour(s)',
   'Option sur forfait appels vers le National 100h : 88 Minutes — validité restante : 21 jour(s)',
   'Forfait Together : 47 Minutes — validité restante : 21 jour(s)'])
 def test_real_capture_never_summed_nor_raw(self):
  result=CAPTURE['client_received_result'];text=fast._display_text(result)
  for unit in ('TND','GO','Minutes'):
   total=sum(__import__('decimal').Decimal(c['value']) for c in result['data']['cards'] if c['unit']==unit)
   with self.subTest(unit=unit):self.assertNotIn(str(total),text)
  self.assertFalse(text.lstrip().startswith(('{','[')))
  for raw in ('https_waaat','maxit_line_view_all','run_','org2','"cards"','DATA'):
   self.assertNotIn(raw,text)
 def test_real_capture_unreadable_card_is_counted_not_dropped_silently(self):
  result=json.loads(json.dumps(CAPTURE['client_received_result']));result['data']['cards'][0]['unit']='private-unit'
  lines=fast._display_text(result).splitlines()
  self.assertEqual(len(lines),8);self.assertEqual(lines[-1],'1 autre(s) carte(s) non affichable(s) en texte.')
 def test_real_capture_fast_path_transports_text_and_provenance(self):
  resolved=CAPTURE['resolution_now']['claw_live']
  executed={**resolved,'execution':{'state':'completed','result':CAPTURE['client_received_result']}}
  with mock.patch.object(fast,'resolve_capability',return_value=resolved),mock.patch.object(fast,'execute_capability_decision',return_value=executed):
   out=fast.try_fast_path(CAPTURE['companion_run']['userText'])
  self.assertEqual(out['status'],'hit');self.assertEqual(len(out['text'].splitlines()),8)
  # The capture has no execution.actual_route and no O1 network path: the owner-reported route wins over the plan.
  self.assertEqual(out['provenance'],{'capability':'telecom.orange.consultation','route':'orange.usage.maxit.v1'})
  self.assertEqual(CAPTURE['provenance_fields']['route_executed_by_owner'],out['provenance']['route'])
 def test_cards_separate_not_summed(self):
  # Negative mutation: label alias and zero validity.
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
 def test_actual_a8_route_wins_over_planned_route(self):
  selected={'capability':'orange.summary','route':'orange.summary.planned'}
  result=fast._execution_provenance(selected,{'actual_route':'orange.usage.actual','network_path':'wifi_off'})
  self.assertEqual(result['route'],'orange.usage.actual')
  self.assertEqual(fast._execution_provenance(selected,{})['route'],'orange.summary.planned')
  for actual in ['x'*161,'https://private.example','',None]:
   self.assertIsNone(fast._execution_provenance(selected,{'actual_route':actual}))
 def test_canonical_free_text_privacy_without_filtering_card_amounts(self):
  for text in ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signatureTest','mon code est 482913','token: private-value','otp 123456','secret field private-value','eyJ'+('a'*10000)+'.'+('b'*10000)+'.signature']:
   for key in ['text','message','summary','answer']:
    with self.subTest(key=key,text=text):self.assertNotIn(text,fast._display_text({key:text}))
  self.assertEqual(fast._display_text({'cards':[{'title':'Compte','value':'482913','unit':'TND'}]}),'Compte : 482913 TND')
 def test_provenance_ids_not_truncated_or_unbounded(self):
  for v in ['x'*161,'https://private.example','owner@example.invalid',None]:self.assertIsNone(fast._execution_provenance({'capability':'orange.balance','route':v},{}))
if __name__=='__main__':unittest.main()
