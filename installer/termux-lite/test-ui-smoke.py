import importlib.util,json,os,tempfile,unittest,time,sys
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
 def test_cli_without_run_flag_never_touches_adb(self):
  with patch.object(m,'Adb',side_effect=AssertionError('no ADB')),patch.object(sys,'argv',['ui-smoke.py']),patch('builtins.print') as output:
   self.assertEqual(m.main(),2)
  self.assertIn('run_flag_required',output.call_args.args[0])
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
  with patch.object(adb,'foreground'),patch.object(adb,'dump',return_value=m.parse_dump(xml('usage-row','Paiement'))),patch.object(adb,'call',side_effect=AssertionError('no tap')):
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

FIX=json.loads((Path(__file__).resolve().parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11c/h9/admission-probes.json').read_text())
AWAKE='  mWakefulness=Awake\n mLastUserActivityTime(excludingAttention)=56987730\n'
FOCUS='  mCurrentFocus=Window{1a2b3c u0 ai.samantha.android.dev/ai.samantha.android.MainActivity}\n'
class FakeAdb:
 def __init__(self,package=FIX['package']['dumpsys_package'],policy='    KeyguardServiceDelegate\n      showing=false\n',power=AWAKE,uptime=FIX['power']['uptime'],focus=FOCUS):
  self.out={('shell','dumpsys','package',m.PACKAGE):package,('shell','dumpsys','window','policy'):policy,('shell','dumpsys','power'):power,('shell','cat','/proc/uptime'):uptime,('shell','dumpsys window | grep -m1 mCurrentFocus'):focus}
  self.calls=[]
 def call(self,args,deadline):
  self.calls.append(tuple(args))
  if tuple(args) not in self.out:raise AssertionError('unexpected ADB '+repr(args))
  return self.out[tuple(args)].encode()
 foreground=m.Adb.foreground
class Admission(unittest.TestCase):
 def test_real_probes_package_confirmed(self):
  pkg=m.parse_package(FIX['package']['dumpsys_package'])
  self.assertEqual(pkg,{'package':'ai.samantha.android.dev','versionName':'0.10.1-native-dev-opt','versionCode':20})
  with self.assertRaises(m.SmokeError) as e:m.parse_package('')
  self.assertEqual(str(e.exception),'package_not_installed')
 def test_real_probes_refuse_locked_dozing_shade(self):
  for fn,args,code in ((m.parse_keyguard,(FIX['keyguard']['dumpsys_window_policy'],),'device_locked_or_unknown'),
                       (m.parse_idle,(FIX['power']['dumpsys_power'],FIX['power']['uptime']),'screen_not_awake'),
                       (m.parse_focus,(FIX['focus']['dumpsys_window'],),'foreground_not_samantha')):
   with self.assertRaises(m.SmokeError) as e:fn(*args)
   self.assertEqual(str(e.exception),code)
 def test_idle_from_real_uptime_and_recent_activity(self):
  self.assertEqual(m.parse_idle(AWAKE,FIX['power']['uptime']),58557730-56987730)
  with self.assertRaises(m.SmokeError) as e:m.parse_idle(AWAKE,'56990.00 1.0\n')
  self.assertEqual(str(e.exception),'recent_user_activity')
  with self.assertRaises(m.SmokeError) as e:m.parse_idle('  mWakefulness=Awake\n','1.0 1.0\n')
  self.assertEqual(str(e.exception),'user_activity_unknown')
 def test_keyguard_ambiguous_refused(self):
  for text in ('','      showing=false\n      showing=true\n'):
   with self.assertRaises(m.SmokeError):m.parse_keyguard(text)
 def test_admission_order_read_only_and_ok(self):
  adb=FakeAdb();out=m.admission(adb,time.monotonic()+5)
  self.assertEqual(out['foreground'],m.PACKAGE);self.assertEqual(out['versionName'],'0.10.1-native-dev-opt')
  self.assertTrue(all(c[0]=='shell' and 'input' not in c for c in adb.calls))
 def test_other_app_foreground_refused(self):
  adb=FakeAdb(focus='  mCurrentFocus=Window{1 u0 com.android.chrome/org.chromium.Main}\n')
  with self.assertRaises(m.SmokeError) as e:m.admission(adb,time.monotonic()+5)
  self.assertEqual(str(e.exception),'foreground_not_samantha')
 def test_cli_refuses_on_real_locked_phone_before_any_tap(self):
  adb=FakeAdb(policy=FIX['keyguard']['dumpsys_window_policy'],power=FIX['power']['dumpsys_power'],focus=FIX['focus']['dumpsys_window'])
  with tempfile.TemporaryDirectory() as td,patch.object(sys,'argv',['ui-smoke.py','--run']),patch('builtins.print') as output:
   code=m.main(lambda:adb,lambda:m.SharedUiLease(Path(td)/'execution.lock'))
  self.assertEqual(code,2);self.assertEqual(json.loads(output.call_args.args[0]),{'state':'not_run','reason':'device_locked_or_unknown'})
  self.assertFalse(any('input' in c for c in adb.calls))
 def test_shared_ui_lease_busy_refuses_without_adb(self):
  import fcntl
  with tempfile.TemporaryDirectory() as td:
   lock=Path(td)/'execution.lock';fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX)
   try:
    with patch.object(sys,'argv',['ui-smoke.py','--run']),patch('builtins.print') as output:
     code=m.main(lambda:FakeAdb(),lambda:m.SharedUiLease(lock))
    self.assertEqual(code,2);self.assertIn('shared_ui_busy',output.call_args.args[0])
   finally:os.close(fd)
   self.assertEqual(oct(lock.stat().st_mode&0o777),'0o600')
 def test_foreground_rechecked_before_each_tap(self):
  adb=FakeAdb(focus='  mCurrentFocus=Window{1 u0 NotificationShade}\n')
  adb.dump=lambda deadline:(_ for _ in ()).throw(AssertionError('no dump'))
  with self.assertRaises(m.SmokeError) as e:m.Adb.tap(adb,'tab-home',time.monotonic()+3)
  self.assertEqual(str(e.exception),'foreground_not_samantha')
 def test_no_personal_dump_versioned(self):
  root=Path(__file__).resolve().parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11c/h9'
  for f in root.iterdir():self.assertNotIn('<hierarchy',f.read_text())

if __name__=='__main__':unittest.main()
