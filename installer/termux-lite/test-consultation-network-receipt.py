"""Owner proof regression: injected device functions, never ADB/network."""
import importlib.util,io,json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout
source=Path(__file__).with_name('android-network-mutation-guard.py')
spec=importlib.util.spec_from_file_location('guard_receipt',source);guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class Receipt(unittest.TestCase):
 def case(self,child,restore_error=None,initial=True,owner_fallback=False):
  with tempfile.TemporaryDirectory() as tmp:
   lease=Path(tmp)/('a'*32+'.json');lease.write_text(json.dumps({'wifi_enabled':initial}))
   def execute(*args,**kwargs):
    if owner_fallback:
     row=json.loads(lease.read_text());row.update(network_path='cellular_bind_wifi_on',network_path_reason='http_400_wifi');lease.write_text(json.dumps(row))
    return child
   calls=[];output=io.StringIO()
   with patch.object(guard,'mutation_lock',return_value=__import__('contextlib').nullcontext()),patch.object(guard,'canonical_consultation_owner',return_value=True),patch.object(guard,'create_lease',return_value=lease),patch.object(guard,'write_json'),patch.object(guard,'process_identity',return_value={'start_ticks':'1','boot_id':'TEST'}),patch.object(guard,'set_wifi') as wifi,patch.object(guard,'restore_lease',side_effect=restore_error) as restore,patch.object(guard,'write_receipt') as receipt,patch.object(guard,'collect_consultation_child',side_effect=execute) as run,redirect_stdout(output):
    code=guard.with_consultation_receipt([guard.sys.executable,'-m','telecom.maxit_guarded_service','balance'])
   return code,json.loads(output.getvalue()),lease.exists(),wifi.call_count,receipt.call_args,run.call_args
 def test_verified_restore_and_dns(self):
  code,payload,exists,calls,receipt,run=self.case(subprocess.CompletedProcess([],0,'{"ok":true,"dns_ready_ms":3500}',''))
  self.assertEqual(code,0);self.assertFalse(exists);self.assertEqual(calls,1);self.assertEqual(payload['network_guard'],{'wifi_initial':True,'wifi_disabled':True,'dns_ready_ms':3500,'restored':True,'lease_id':'a'*32,'path':'wifi_off'})
  self.assertEqual(run.args[1]['SAMANTHA_MAXIT_LEASE_ID'],'a'*32)
 def test_dns_timeout_is_not_service_success(self):
  code,payload,*_=self.case(subprocess.CompletedProcess([],4,'{"ok":false,"source":"maxit_mobile_readiness","dns_ready_ms":null}',''))
  self.assertEqual(code,4);self.assertFalse(payload['ok']);self.assertTrue(payload['network_guard']['restored']);self.assertIsNone(payload['network_guard']['dns_ready_ms'])
 def test_restore_failed_retains_lease_and_refuses_success(self):
  code,payload,exists,*_=self.case(subprocess.CompletedProcess([],0,'{"ok":true}',''),RuntimeError('TEST'))
  self.assertEqual(code,4);self.assertTrue(exists);self.assertFalse(payload['ok']);self.assertFalse(payload['network_guard']['restored']);self.assertEqual(payload['state'],'restoration_failed')
 def test_fallback_proof_is_closed_and_bounded(self):
  code,payload,*_=self.case(subprocess.CompletedProcess([],0,'{"ok":true,"network_path":"cellular_bind_wifi_on","network_path_reason":"http_400_wifi","dns_ready_ms":23}',''),owner_fallback=True)
  self.assertEqual(payload['network_guard']['path'],'cellular_bind_wifi_on');self.assertEqual(payload['network_guard']['reason'],'http_400_wifi');self.assertTrue(payload['network_guard']['wifi_disabled'])
  _,untrusted,*_=self.case(subprocess.CompletedProcess([],0,'{"ok":true,"network_path":"cellular_bind_wifi_on","network_path_reason":"http_400_wifi"}',''))
  self.assertEqual(untrusted['network_guard']['path'],'wifi_off')
  _,p,*_=self.case(subprocess.CompletedProcess([],0,'{"ok":true,"network_path":"evil","dns_ready_ms":-1}',''))
  self.assertEqual(p['network_guard']['path'],'wifi_off');self.assertIsNone(p['network_guard']['dns_ready_ms'])
 def test_fake_or_expired_lease_does_not_admit(self):
  for value in ['../escape','0'*32,'']:
   self.assertFalse(guard.verify_consultation_lease(value))
 def test_owner_identity_and_age_are_required(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);owner=guard.os.getpid();identity={'start_ticks':'1','boot_id':'TEST'}
   row={'schema_version':1,'type':'wifi_off','purpose':'maxit-deterministic','owner_pid':owner,'owner_identity':identity,'created_at':guard.time.time()}
   source=root/('a'*32+'.json')
   with patch.object(guard,'LEASES',root),patch.object(guard,'canonical_consultation_owner',return_value=True),patch.object(guard,'consultation_lock_owned',return_value=True),patch.object(guard,'process_identity',return_value=identity):
    source.write_text(json.dumps(row));self.assertTrue(guard.verify_consultation_lease('a'*32))
    for values in [{'created_at':1},{'purpose':'payment'},{'owner_identity':{'start_ticks':'other'}},{'owner_pid':True}]:
     source.write_text(json.dumps({**row,**values}));self.assertFalse(guard.verify_consultation_lease('a'*32))
 def test_owner_prepares_wifi_on_under_same_lease_or_refuses(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/('a'*32+'.json');source.write_text(json.dumps({'wifi_enabled':True}))
   with patch.object(guard,'LEASES',root),patch.object(guard,'verify_consultation_lease',return_value=True),patch.object(guard,'wifi_enabled',side_effect=[False,True]),patch.object(guard,'set_wifi') as mutation:
    self.assertTrue(guard.prepare_consultation_cellular('a'*32));mutation.assert_called_once_with(True)
   self.assertEqual(json.loads(source.read_text())['network_path'],'cellular_bind_wifi_on')
   source.write_text(json.dumps({'wifi_enabled':False}))
   with patch.object(guard,'LEASES',root),patch.object(guard,'verify_consultation_lease',return_value=True),patch.object(guard,'set_wifi') as mutation:
    self.assertFalse(guard.prepare_consultation_cellular('a'*32));mutation.assert_not_called()
   source.write_text(json.dumps({'wifi_enabled':True}))
   with patch.object(guard,'LEASES',root),patch.object(guard,'verify_consultation_lease',return_value=True),patch.object(guard,'wifi_enabled',return_value=False),patch.object(guard,'set_wifi'):
    self.assertFalse(guard.prepare_consultation_cellular('a'*32));self.assertNotIn('network_path',json.loads(source.read_text()))
 def test_busy_lock_has_no_snapshot_or_raw_error(self):
  output=io.StringIO()
  with patch.object(guard,'mutation_lock',side_effect=RuntimeError('network_mutation_guard_busy')),patch.object(guard,'create_lease') as snapshot,redirect_stdout(output):
   self.assertEqual(guard.with_consultation_receipt([guard.sys.executable,'-m','telecom.maxit_guarded_service','balance']),4)
  snapshot.assert_not_called();self.assertEqual(json.loads(output.getvalue()),{'ok':False,'source':'maxit_network_guard','state':'guard_busy'})
 def test_unverified_child_cleanup_never_certifies_restore(self):
  with tempfile.TemporaryDirectory() as tmp:
   lease=Path(tmp)/('a'*32+'.json');lease.write_text(json.dumps({'wifi_enabled':True}));output=io.StringIO()
   with patch.object(guard,'mutation_lock',return_value=__import__('contextlib').nullcontext()),patch.object(guard,'canonical_consultation_owner',return_value=True),patch.object(guard,'create_lease',return_value=lease),patch.object(guard,'write_json'),patch.object(guard,'process_identity',return_value={'start_ticks':'1','boot_id':'TEST'}),patch.object(guard,'set_wifi'),patch.object(guard,'restore_lease') as restore,patch.object(guard,'write_receipt') as receipt,patch.object(guard,'collect_consultation_child',side_effect=guard.ConsultationChildFailure('child_cleanup_unverified',False)),redirect_stdout(output):
    self.assertEqual(guard.with_consultation_receipt([guard.sys.executable,'-m','telecom.maxit_guarded_service','balance']),4)
   value=json.loads(output.getvalue());self.assertFalse(value['network_guard']['restored']);self.assertTrue(lease.exists());self.assertEqual(receipt.call_args.args[0],'degraded');restore.assert_called_once()
 def test_unexpected_collector_interrupt_keeps_cleanup_unverified(self):
  for failure in [KeyboardInterrupt(),OSError('TEST')]:
   with self.subTest(error=type(failure).__name__),tempfile.TemporaryDirectory() as tmp:
    lease=Path(tmp)/('a'*32+'.json');lease.write_text(json.dumps({'wifi_enabled':True}));output=io.StringIO()
    with patch.object(guard,'mutation_lock',return_value=__import__('contextlib').nullcontext()),patch.object(guard,'canonical_consultation_owner',return_value=True),patch.object(guard,'create_lease',return_value=lease),patch.object(guard,'write_json'),patch.object(guard,'process_identity',return_value={'start_ticks':'1','boot_id':'TEST'}),patch.object(guard,'set_wifi'),patch.object(guard,'restore_lease'),patch.object(guard,'write_receipt') as receipt,patch.object(guard,'collect_consultation_child',side_effect=failure),redirect_stdout(output):
     self.assertEqual(guard.with_consultation_receipt([guard.sys.executable,'-m','telecom.maxit_guarded_service','balance']),4)
    self.assertFalse(json.loads(output.getvalue())['network_guard']['restored']);self.assertTrue(lease.exists());self.assertEqual(receipt.call_args.args[0],'degraded')
 def test_generic_payment_guard_is_unchanged(self):
  import ast,json,hashlib
  capture=json.loads((Path(__file__).parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/o1/network-guard-source.json').read_text())
  code=source.read_text();tree=ast.parse(code);function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='with_wifi_off')
  self.assertEqual(ast.get_source_segment(code,function),capture['functions']['with_wifi_off'])
if __name__=='__main__':unittest.main()
