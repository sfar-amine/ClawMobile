"""J1/H8 integration on generated public fixtures; never scan runtime data."""
import copy,datetime as dt,hashlib,importlib.util,json,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('j1_nightly','companion-nightly-acceptance.py');hook=load('j1_hook','nightly-secret-scan.py')
CAPTURE=json.loads((ROOT.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/h8/acceptance-receipts.json').read_text())
ACCEPT=copy.deepcopy(CAPTURE['samples'][0]['acceptance'])
# Low latencies isolate the hook state machine, not a claimed S24 measurement.
for check in ACCEPT['checks']:check['seconds']=min(.001,check['budget']*.01)
NOW=dt.datetime(2026,10,11,2,tzinfo=dt.timezone.utc)

class HookTests(unittest.TestCase):
 def test_real_scanner_hook_new_signatures_daily_dedup_and_no_values(self):
  with tempfile.TemporaryDirectory() as td:
   folder=Path(td);workspace=folder/'workspace';workspace.mkdir();state=folder/'deploys';source=workspace/'sample.txt'
   public='Bearer '+'fixturePublicSynthetic'*2;source.write_text(public+'\nowner@example.invalid')
   calls=[];notified=[]
   def runner(command,timeout):
    calls.append((command,timeout))
    if command[-1].endswith('companion-acceptance.py'):return 0,copy.deepcopy(ACCEPT)
    self.assertEqual(command[:4],[sys.executable,str(ROOT/'workspace-secret-scan.py'),'--root','workspace='+str(workspace)])
    self.assertEqual(command[4:],['--seconds','10','--max-files','10000','--max-bytes',str(64*1024*1024),'--max-entries','20000','--max-findings','1000'])
    self.assertEqual(timeout,12)
    return m.bounded_command(command,timeout)
   def execute(day):
    return m.execute(state,ROOT,NOW+dt.timedelta(days=day),runner=runner,notifier=lambda:notified.append(day),preflight=lambda:True,secret_roots=[('workspace',workspace)])
   before=source.stat().st_mtime_ns;result,code=execute(0)
   self.assertEqual((result['state'],code),('attention',1));self.assertEqual(notified,[0]);self.assertEqual(before,source.stat().st_mtime_ns)
   receipt=m.read_receipt(state/'nightly-20261011.json');self.assertEqual(receipt['secretScan']['newFindingCount'],1);self.assertEqual(len(receipt['secretScan']['warnings']),1)
   rendered=json.dumps(receipt);self.assertNotIn(public,rendered);self.assertNotIn('owner@example.invalid',rendered);self.assertNotIn(str(workspace),rendered)
   execute(0);self.assertEqual(len(calls),2);self.assertEqual(notified,[0])
   result,code=execute(1);self.assertEqual((result['state'],code),('ok',0));self.assertEqual(notified,[0])
   source.write_text('Bearer '+'differentPublicSynthetic'*2)
   execute(2);execute(2);self.assertEqual(notified,[0,2])
 def test_without_configuration_never_scans_or_claims_no_findings(self):
  with tempfile.TemporaryDirectory() as td:
   calls=[]
   def runner(command,timeout):calls.append(command);return 0,ACCEPT
   m.execute(Path(td),ROOT,NOW,runner=runner,preflight=lambda:True)
   row=m.read_receipt(Path(td)/'nightly-20261011.json')
   self.assertEqual(row['secretScan'],{'state':'not_configured'});self.assertEqual(len(calls),1)
 def test_boundary_closed_redacts_paths_and_ignores_values(self):
  owner=hook.scanner_owner(ROOT);secret='sk-'+'F'*30
  raw={'schemaVersion':1,'state':'ok','findings':[{'path':'workspace/'+secret,'line':1,'type':'token','hash':'a'*16,'value':secret}],'warnings':[],'stats':{'files':1,'bytes':10,'entries':1,'skipped':0},'body':secret}
  closed=hook.closed_scan(raw,owner);self.assertNotIn(secret,json.dumps(closed));self.assertEqual(set(closed['findings'][0]),{'path','line','type','hash'})
  raw['findings']*=1001
  with self.assertRaises(ValueError):hook.closed_scan(raw,owner)
 def test_partial_failure_and_invalid_output_fail_closed(self):
  raw={'schemaVersion':1,'state':'partial','findings':[],'warnings':[],'stats':{'files':0,'bytes':0,'entries':0,'skipped':0}}
  out,attention=hook.execute_scan(ROOT,[('workspace','/synthetic/not-read')],[],lambda *_:(2,raw))
  self.assertTrue(attention);self.assertEqual(out['state'],'partial');self.assertEqual(out['newFindingCount'],0)
  for response in [(0,raw),(1,{'sensitive':'never-copy'}),(1,dict(raw,state='ok'))]:
   out,attention=hook.execute_scan(ROOT,[('workspace','/synthetic/not-read')],[],lambda *_:response)
   self.assertEqual(out['state'],'partial');self.assertEqual(out['roots'][0]['state'],'partial');self.assertTrue(attention)
  def failure(*_):raise subprocess.TimeoutExpired('synthetic-private-command',12)
  out,_=hook.execute_scan(ROOT,[('workspace','/synthetic/not-read')],[],failure)
  self.assertNotIn('synthetic-private-command',json.dumps(out))
 def test_explicit_root_validation_and_missing_scanner(self):
  for roots in [[('workspace','relative')],[('../bad','/tmp')],[('workspace','/tmp\0secret')],[('workspace','/tmp')]*9]:
   with self.assertRaises(ValueError):hook.explicit_roots(roots)
  with tempfile.TemporaryDirectory() as td:
   out,attention=hook.execute_scan(Path(td),[('workspace',td)],[],lambda *_:self.fail('not installed'))
   self.assertEqual(out['reason'],'secret_scan_not_installed');self.assertTrue(attention)
 def test_schema_version_bool_is_not_an_integer_version(self):
  raw={'schemaVersion':True,'state':'ok','findings':[],'warnings':[],'stats':{'files':0,'bytes':0,'entries':0,'skipped':0}}
  with self.assertRaises(ValueError):hook.closed_scan(raw,hook.scanner_owner(ROOT))
 def test_signature_changes_and_email_only_do_not_alert(self):
  raw={'schemaVersion':1,'state':'ok','findings':[],'warnings':[{'path':'workspace/public','line':1,'type':'email','hash':'b'*16}],'stats':{'files':1,'bytes':10,'entries':1,'skipped':0}}
  out,attention=hook.execute_scan(ROOT,[('workspace','/synthetic/not-read')],[],lambda *_:(0,raw));self.assertFalse(attention);self.assertEqual(out['newFindingCount'],0)
  one={'path':'workspace/public','line':1,'type':'token','hash':'a'*16}
  self.assertNotEqual(hook.signatures([one]),hook.signatures([dict(one,hash='b'*16)]))
if __name__=='__main__':unittest.main()
