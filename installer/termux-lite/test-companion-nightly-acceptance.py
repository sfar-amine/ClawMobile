import copy,datetime as dt,fcntl,importlib.util,json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('nightly',ROOT/'companion-nightly-acceptance.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
FIXTURE=ROOT.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/h8/acceptance-receipts.json'
CAPTURE=json.loads(FIXTURE.read_text())
REAL=CAPTURE['samples'][0]['acceptance']
NOW=dt.datetime(2026,10,11,2,0,tzinfo=dt.timezone.utc)
class NightlyTests(unittest.TestCase):
 def execute(self,state,raw=None,**kw):return m.execute(state,ROOT,NOW,runner=lambda cmd,timeout:(0,copy.deepcopy(REAL if raw is None else raw)),notifier=lambda:None,preflight=lambda:True,**kw)
 def test_real_s24_receipts_are_closed_and_comparable(self):
  for sample in CAPTURE['samples']:
   closed=m.closed_acceptance(sample['acceptance']);self.assertTrue(closed['accepted']);self.assertEqual(len(closed['checks']),44)
   self.assertFalse(any('body' in row for row in closed['checks']))
  self.assertNotIn('@',json.dumps(CAPTURE));self.assertIn('read-only',CAPTURE['capture']['source'])
 def test_real_s24_auxiliary_prewarm_and_voice_rows_are_closed_not_unavailable(self):
  # Real S24 receipt 17/10 (release 636becf5): prewarm and voice_runs_terminal_state rows have no budget.
  aux=json.loads((ROOT.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-17/h8/acceptance-with-auxiliary-checks.json').read_text())['acceptance']
  closed=m.closed_acceptance(aux)
  self.assertEqual(len(closed['checks'])+len(closed['auxiliary']),len(aux['checks']))
  self.assertEqual({row['check'] for row in closed['auxiliary']},{'prewarm','voice_runs_terminal_state'})
  self.assertTrue(all('budget' in row for row in closed['checks']))
  self.assertFalse(any(row['route']=='/catalog' and row['seconds']==1.93 for row in closed['checks']))
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);result,code=self.execute(state,aux)
   receipt=m.read_receipt(state/'nightly-20261011.json')
   self.assertIn(result['state'],('ok','attention'));self.assertNotIn('reason',receipt)
   self.assertFalse(any(row['route']=='/catalog' and row['seconds']==1.93 for row in receipt['drift']))
  for bad in ({'route':'/catalog','check':'Prewarm!','status':'ok'},{'route':'/catalog','check':'prewarm','status':'maybe'}):
   with self.assertRaises(ValueError):m.closed_acceptance({'accepted':True,'checks':[bad]})
  failed=copy.deepcopy(aux);failed['accepted']=False;failed['checks'][0]['status']='fail'
  with tempfile.TemporaryDirectory() as td:
   result,code=self.execute(Path(td),failed);self.assertEqual((result['state'],code),('failed',1))
 def test_full_checkout_acceptance_under_deployment_lock_and_daily_idempotence(self):
  calls=[];notifications=[]
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);root=state/'checkout';root.mkdir()
   def runner(cmd,timeout):
    calls.append(cmd);self.assertEqual(cmd,[sys.executable,str(root/'companion-acceptance.py')]);self.assertEqual(timeout,900)
    with (state/'companion-deploy.lock').open('w') as lock:
     with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    return 0,REAL
   result,code=m.execute(state,root,NOW,runner=runner,notifier=lambda:notifications.append(1),preflight=lambda:True)
   self.assertIn(result['state'],('ok','attention'));self.assertEqual(len(calls),1)
   self.assertEqual((state/'nightly-20261011.json').stat().st_mode&0o777,0o600)
   self.assertEqual(m.read_receipt(state/'nightly-20261011.json')['secretScan']['state'],'not_configured')
   again,_=m.execute(state,root,NOW,runner=runner,notifier=lambda:notifications.append(1),preflight=lambda:True)
   self.assertEqual(again['state'],'already_checked');self.assertEqual(len(calls),1);self.assertLessEqual(len(notifications),1)
 def test_busy_lock_and_preflight_do_not_run_or_write_receipt(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);lock=(state/'companion-deploy.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX)
   called=[]
   out,code=m.execute(state,ROOT,NOW,runner=lambda *_:called.append(1),preflight=lambda:True)
   self.assertEqual((code,out['reason']),(3,'deployment_lock_busy'));lock.close()
   out,code=m.execute(state,ROOT,NOW,runner=lambda *_:called.append(1),preflight=lambda:False)
   self.assertEqual((code,out['reason']),(3,'deployment_preflight_busy'));self.assertEqual(called,[])
   self.assertFalse((state/'nightly-20261011.json').exists())
 def test_emergency_stop_refuses_without_running_or_writing(self):
  with tempfile.TemporaryDirectory() as td:
   oc=Path(td);state=oc/'deploys';stop=oc/'tier0/emergency-stop.json';stop.parent.mkdir();stop.write_text('{"enabled":true}')
   called=[];out,code=m.execute(state,ROOT,NOW,runner=lambda *_:called.append(1),preflight=lambda:True)
   self.assertEqual((code,out['reason']),(3,'emergency_stop_active'));self.assertEqual(called,[])
   self.assertFalse(state.exists())
 def test_seven_night_median_and_duplicate_route_budgets_do_not_mix(self):
  # Generated dates/latencies for the drift boundary, retaining real captured route forms.
  row=copy.deepcopy(REAL['checks'][0]);row.update(seconds=0.2,budget=2,status='ok')
  history=[{'acceptance':{'accepted':True,'checks':[dict(row,seconds=x)]}} for x in (.2,.1,.3,.2,.4,.1,.2)]
  result=m.drift({'accepted':True,'checks':[dict(row,seconds=.31)]},history)
  self.assertEqual(result[0]['median7'],.2);self.assertEqual(result[0]['baselineNights'],7);self.assertEqual(result[0]['reasons'],['over_1_5_median'])
  result=m.drift({'accepted':True,'checks':[dict(row,seconds=1.61,budget=2),dict(row,seconds=.31,budget=1.5)]},history)
  self.assertIn('budget_over_80_percent',result[0]['reasons']);self.assertIsNone(result[1]['median7'])
  skipped=dict(row,status='skipped',seconds=100);self.assertEqual(m.drift({'accepted':True,'checks':[skipped]},history),[])
 def test_notification_reserved_before_uncertain_call_never_replayed(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);raw=copy.deepcopy(REAL);raw['accepted']=False;raw['checks'][0]['status']='fail';calls=[]
   def notify():
    calls.append(1);row=m.read_receipt(state/'nightly-20261011.json');self.assertIsNotNone(row['notificationAttemptedAt']);raise RuntimeError('simulated crash after owner admission')
   with self.assertRaises(RuntimeError):m.execute(state,ROOT,NOW,runner=lambda *_:(1,raw),notifier=notify,preflight=lambda:True)
   out,_=m.execute(state,ROOT,NOW,runner=lambda *_:(1,raw),notifier=notify,preflight=lambda:True)
   self.assertEqual(out['state'],'already_checked');self.assertEqual(calls,[1])
 def test_retention_only_thirty_nightly_receipts_and_no_symlinks_followed(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td)
   for i in range(600):
    date=(NOW-dt.timedelta(days=i+1)).strftime('%Y%m%d');(state/('nightly-'+date+'.json')).write_text('{}')
   deploy=state/'companion-real.json';deploy.write_text('immutable')
   outside=state/'outside';outside.write_text('immutable');(state/'nightly-20000101.json').symlink_to(outside)
   m.retain(state);self.assertEqual(len(list(m.nightly_files(state))),30);self.assertEqual(deploy.read_text(),'immutable');self.assertEqual(outside.read_text(),'immutable');self.assertTrue((state/'nightly-20000101.json').is_symlink())
 def test_receipt_fifo_is_rejected_without_blocking(self):
  with tempfile.TemporaryDirectory() as td:
   fifo=Path(td)/'nightly-20261011.json';os.mkfifo(fifo);start=time.monotonic()
   self.assertIsNone(m.read_receipt(fifo));self.assertLess(time.monotonic()-start,.1)
 def test_receipt_limits_and_raw_bodies_never_stored(self):
  for invalid in ({'accepted':True,'checks':[{}]},dict(REAL,checks=REAL['checks']*6)):
   with self.assertRaises(ValueError):m.closed_acceptance(invalid)
  raw=copy.deepcopy(REAL);raw['checks'][0]['body']='Bearer never-persist-this';raw['warnings']=[{'email':'never@example.invalid'}]
  self.assertNotIn('Bearer',json.dumps(m.closed_acceptance(raw)));self.assertNotIn('@',json.dumps(m.closed_acceptance(raw)))
 def test_health_fresh_attention_missing_and_stale(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);self.assertEqual(m.health_view(state,NOW.timestamp())['state'],'unverified')
   m.atomic_receipt(state/'nightly-20261011.json',{'at':NOW.isoformat(),'state':'attention'})
   self.assertEqual(m.health_view(state,NOW.timestamp())['state'],'attention');self.assertEqual(m.health_view(state,NOW.timestamp()+37*3600)['state'],'stale')
 def test_closed_email_warning_is_nonblocking_and_unknown_warnings_are_dropped(self):
  raw={'accepted':True,'checks':[], 'warnings':[{'route':'/control/health?contract=2','warning':'email_address_in_response'},{'route':'/usage','warning':'unknown'},{'route':'/usage','warning':'email_address_in_response','value':'private@example.invalid'},{'route':'/@private','warning':'email_address_in_response'},None]}
  closed=m.closed_acceptance(raw)
  self.assertEqual(closed['warnings'],[{'route':'/control/health?contract=2','warning':'email_address_in_response'}]);self.assertNotIn('@',json.dumps(closed))
  raw['warnings']=[raw['warnings'][0]]*300;self.assertEqual(len(m.closed_acceptance(raw)['warnings']),200)
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);out,code=self.execute(state,raw=raw)
   self.assertEqual((code,out['state']),(0,'ok'));self.assertEqual(len(m.read_receipt(state/'nightly-20261011.json')['acceptance']['warnings']),200)
 def test_successful_parent_cleans_ready_descendant_before_unlock(self):
  # Descendant signals readiness before its parent exits. It closes stdout and
  # remains alive independently, reproducing the successful-parent leak.
  with tempfile.TemporaryDirectory() as td:
   ready=Path(td)/'ready';pidfile=Path(td)/'pid'
   childcode="import pathlib,time;pathlib.Path(%r).write_text('ready');time.sleep(30)"%str(ready)
   parentcode="import subprocess,sys,pathlib,time,json;child=subprocess.Popen([sys.executable,'-c',%r],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);pathlib.Path(%r).write_text(str(child.pid));deadline=time.monotonic()+2\nwhile not pathlib.Path(%r).exists():\n if time.monotonic()>deadline:raise RuntimeError('not_ready')\n time.sleep(.01)\nprint(json.dumps({'accepted':True,'checks':[]}))"%(childcode,str(pidfile),str(ready))
   started=time.monotonic()
   try:
    code,row=m.bounded_command([sys.executable,'-c',parentcode],3)
    self.assertEqual(code,0);self.assertTrue(row['accepted']);self.assertTrue(ready.exists())
    pid=int(pidfile.read_text());proc=Path('/proc')/str(pid)/'stat'
    # A zombie is already terminated; PID1 reaping is outside our ownership.
    try:self.assertIn(proc.read_text().rsplit(')',1)[1].split()[0],('Z','X'))
    except FileNotFoundError:pass
    self.assertLess(time.monotonic()-started,5)
   finally:
    if pidfile.exists():
     try:os.kill(int(pidfile.read_text()),9)
     except ProcessLookupError:pass
 def test_bounded_real_process_stdout_and_timeout(self):
  code,row=m.bounded_command([sys.executable,'-c','import json;print(json.dumps({"accepted":True,"checks":[]}))'],1)
  self.assertEqual((code,row),(0,{'accepted':True,'checks':[]}))
  with self.assertRaises(ValueError):m.bounded_command([sys.executable,'-c','print("x"*1000)'],1,max_bytes=50)
  started=time.monotonic()
  with self.assertRaises(TimeoutError):m.bounded_command([sys.executable,'-c','import time;time.sleep(20)'],.05)
  self.assertLess(time.monotonic()-started,1)
if __name__=='__main__':unittest.main()
