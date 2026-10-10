import importlib.util,unittest,time,sys
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('smoke',Path(__file__).with_name('ui-smoke.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def xml(tag='usage-screen',text='Prêt',package=m.PACKAGE):
 return ('<?xml version="1.0"?><hierarchy><node package="'+package+'" resource-id="'+tag+'" enabled="true" text="'+text+'" bounds="[0,0][20,20]"/></hierarchy>').encode()
class Tests(unittest.TestCase):
 def test_synthetic_tag_and_no_export_fail_closed(self):
  self.assertEqual(m.find_tag(m.parse_dump(xml()),'usage-screen').get('text'),'Prêt')
  with self.assertRaises(m.SmokeError):m.find_tag(m.parse_dump(xml('')),'usage-screen')
  with self.assertRaises(m.SmokeError):m.find_tag(m.parse_dump(xml(package='other')),'usage-screen')
 def test_app_behind_overlay_and_wrong_root_provenance_are_refused(self):
  raw=xml().replace(b'</hierarchy>',b'<node package="other.overlay" resource-id="overlay" enabled="true"/></hierarchy>')
  with self.assertRaises(m.SmokeError):m.find_tag(m.parse_dump(raw),'usage-screen')
  raw=xml().replace(b'<hierarchy>',b'<hierarchy package="other.overlay">')
  with self.assertRaises(m.SmokeError):m.find_tag(m.parse_dump(raw),'usage-screen')
 def test_live_cli_run_refuses_before_any_adb(self):
  with patch.object(m,'Adb',side_effect=AssertionError('no ADB admission')),patch.object(sys,'argv',['ui-smoke.py','--run']),patch('builtins.print') as output:
   self.assertEqual(m.main(),2)
  self.assertIn('canonical_ui_admission_not_qualified',output.call_args.args[0])
 def test_raw_markup_and_http_200_unavailable(self):
  self.assertIn('unavailable_after_http_200',m.inspect(m.parse_dump(xml(text='Indisponible')),200)['errors'])
  self.assertNotIn('unavailable_after_http_200',m.inspect(m.parse_dump(xml(text='Indisponible')),503)['errors'])
  self.assertIn('raw_format_displayed',m.inspect(m.parse_dump(xml(text='**Titre**')),200)['errors'])
 def test_privacy_warnings_are_closed_and_nonblocking(self):
  out=m.inspect(m.parse_dump(xml(text='owner@example.invalid +21612345678')),200)
  self.assertEqual(out['errors'],[]);self.assertEqual(set(out['warnings']),{'email_address_displayed','full_number_displayed'});self.assertNotIn('@',str(out))
 def test_all_actions_payment_and_unknown_refused_before_adb(self):
  adb=m.Adb()
  with patch.object(adb,'call',side_effect=AssertionError('no ADB')):
   for tag in ('pay','bank','payment-screen','recharge','execute','delete','save','send','switch','confirm','control-automation-random'):
    with self.assertRaises(m.SmokeError):adb.tap(tag,time.monotonic()+3)
   with self.assertRaises(m.SmokeError):adb.search('composer','message',time.monotonic()+3)
 def test_safe_tag_with_payment_text_never_taps(self):
  adb=m.Adb()
  with patch.object(adb,'dump',return_value=m.parse_dump(xml('usage-row','Paiement'))),patch.object(adb,'call',side_effect=AssertionError('no tap')):
   with self.assertRaises(m.SmokeError):adb.tap('usage-row',time.monotonic()+3)
 def test_dump_limits_entities_and_no_file(self):
  for raw in (b'<!DOCTYPE x><hierarchy/>',b'x'*(m.MAX_XML+1),b'not xml'):
   with self.assertRaises(m.SmokeError):m.parse_dump(raw)
  adb=m.Adb()
  with patch.object(adb,'call',return_value=xml()) as call:adb.dump(time.monotonic()+3)
  self.assertEqual(call.call_args.args[0],['exec-out','uiautomator','dump','/dev/tty'])
 def test_finally_home_after_route_failure(self):
  class Fake:
   def __init__(self):self.calls=[]
   def tap(self,tag,deadline):self.calls.append(tag);raise m.SmokeError('absent')
   def home(self):self.calls.append('HOME')
  adb=Fake();out=m.run(adb)
  self.assertEqual(out['state'],'failed');self.assertEqual(adb.calls[-2:],['tab-home','HOME'])
 def test_real_route_binding_not_fake_route(self):
  class Fake:
   def tap(self,tag,deadline):pass
   def dump(self,deadline):return m.parse_dump(xml(m.SCREENS[self.index][2]))
   def home(self):pass
  adb=Fake();routes=[]
  def probe(route,deadline):routes.append(route);adb.index+=1;return 200
  adb.index=0;out=m.run(adb,probe)
  self.assertEqual(out['state'],'ok');self.assertEqual(routes,['/usage','/providers','/files?scope=agent'])
if __name__=='__main__':unittest.main()
