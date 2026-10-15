#!/usr/bin/env python3
"""Orange owner evidence: real kernel FD/process tests, captured Android shapes, zero Android/provider calls."""
import fcntl,importlib.util,json,os,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('guard_fast',HERE/'android-network-mutation-guard.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
fixtures=HERE.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-15/orange'
shape=json.loads((fixtures/'network-shape.json').read_text());identity=json.loads((fixtures/'identity.json').read_text())

def projected_network(networks,default):
    """Derived test strings: join only whitelisted captured facts, never claim these are raw dumps."""
    lines=['Active default network: '+str(default)]
    for n in networks:
        kind='CELLULAR' if n.get('cellular') else 'VPN' if n.get('vpn') else 'WIFI'
        ni='MOBILE[LTE] CONNECTED extra: '+('weborange' if n.get('orange_apn') else 'REDACTED') if kind=='CELLULAR' else kind+' CONNECTED extra: REDACTED'
        caps='INTERNET'+('&NOT_VPN' if n.get('not_vpn') else '')+('&VALIDATED' if n.get('validated') else '')
        sub=n.get('subscription_id');tail='' if sub is None else ' Specifier: <TelephonyNetworkSpecifier [mSubId = '+str(sub)+']> SubscriptionIds: {'+','.join(map(str,n.get('subscription_ids') or []))+'}'
        lines.append('NetworkAgentInfo{network{'+str(n['net_id'])+'} handle{'+str(n.get('handle',1197406605325))+'} ni{'+ni+'} nc{[ Transports: '+kind+' Capabilities: '+caps+tail+' ]}}')
    return '\n'.join(lines)
EMPTYSETTINGS={key:{'exists':False,'value':None} for key in g.KEYS}
SUBSCRIPTIONS='\n'.join('SubscriptionInfo{ id='+r['subscription_id']+' simSlotIndex='+r['slot_index']+' mcc='+r['mcc']+' mnc='+r['mnc']+'}' for r in identity['subscription_shapes']['records'])

class CapturedSelection(unittest.TestCase):
    def test_real_capture_default_cellular_and_wifi_parallel(self):
        networks=shape['network']['networks'];raw=projected_network(networks,shape['network']['default_net_id'])
        decision=g.parse_consultation_selection(raw,str(shape['multi_sim_data_call']),SUBSCRIPTIONS,bool(shape['wifi_on']))
        self.assertEqual(decision['route'],'cellular_bound_wifi_unchanged');self.assertEqual(decision['selection'],{'networkHandle':1197406605325,'defaultDataSubscriptionId':1})
        cell=[n for n in networks if n['cellular']];decision=g.parse_consultation_selection(projected_network(cell,278),'1',SUBSCRIPTIONS,False)
        self.assertEqual(decision['route'],'cellular_default');self.assertNotIn('selection',decision)
        self.assertEqual(g.parse_consultation_selection(projected_network(cell,278),'1',SUBSCRIPTIONS,True)['route'],'cellular_default')
    def test_vpn_ambiguous_unknown_and_wrong_sim_never_promoted(self):
        base=shape['network']['networks'];raw=projected_network(base,279)
        self.assertEqual(g.parse_consultation_selection(raw,'4',SUBSCRIPTIONS,True)['route'],'blocked')
        self.assertEqual(g.parse_consultation_selection(raw,None,SUBSCRIPTIONS,True)['route'],'blocked')
        vpn={'net_id':999,'handle':111,'vpn':True,'validated':True,'not_vpn':False}
        self.assertEqual(g.parse_consultation_selection(projected_network([*base,vpn],279),'1',SUBSCRIPTIONS,True)['reason'],'vpn_active')
        other={**base[0],'net_id':280,'handle':112,'subscription_id':4,'subscription_ids':[4],'orange_apn':False}
        self.assertEqual(g.parse_consultation_selection(projected_network([*base,other],279),'1',SUBSCRIPTIONS,True)['reason'],'cellular_network_ambiguous')
        self.assertEqual(g.parse_consultation_selection('x'*1048577,'1',SUBSCRIPTIONS,True)['reason'],'network_observation_limit')
    def test_single_inspection_snapshot_reuses_existing_settings(self):
        raw=projected_network(shape['network']['networks'],279);calls=[]
        state={k:{'exists':False,'value':None} for k in g.KEYS+g.AUTO_WIFI_KEYS};state['multi_sim_data_call']={'exists':True,'value':'1'}
        def adb(*args,**kwargs):
            calls.append(args);return subprocess.CompletedProcess(args,0,raw if args[-1]=='connectivity' else SUBSCRIPTIONS,'')
        with patch.object(g,'settings_state',return_value=state),patch.object(g,'wifi_enabled',return_value=True),patch.object(g,'adb',side_effect=adb):snapshot=g.capture_consultation_snapshot()
        self.assertEqual(calls,[('shell','dumpsys','connectivity'),('shell','dumpsys','isub')]);self.assertEqual(snapshot['decision']['route'],'cellular_bound_wifi_unchanged')
        with tempfile.TemporaryDirectory() as tmp,patch.object(g,'LEASES',Path(tmp)),patch.object(g,'settings_state') as settings,patch.object(g,'wifi_enabled') as wifi,patch.object(g,'auto_wifi_state') as auto:
            row=json.loads(g.create_lease('maxit-deterministic',lease_type='wifi_off',include_wifi=True,snapshot=snapshot).read_text())
            settings.assert_not_called();wifi.assert_not_called();auto.assert_not_called();self.assertTrue(row['wifi_enabled'])
    def test_active_external_proxy_closes_admission(self):
        state={k:{'exists':False,'value':None} for k in g.KEYS+g.AUTO_WIFI_KEYS};state['multi_sim_data_call']={'exists':True,'value':'1'}
        state['http_proxy']={'exists':True,'value':'proxy.invalid:8080'}
        def adb(*args,**kwargs):return subprocess.CompletedProcess(args,0,projected_network(shape['network']['networks'],279) if args[-1]=='connectivity' else SUBSCRIPTIONS,'')
        with patch.object(g,'settings_state',return_value=state),patch.object(g,'wifi_enabled',return_value=True),patch.object(g,'adb',side_effect=adb):
            self.assertEqual(g.capture_consultation_snapshot()['decision']['reason'],'external_proxy_active')
    def test_existing_s24_offer_enabled_bit_does_not_prove_effective_restore(self):
        capture=json.loads((fixtures/'read-offer.json').read_text());before=capture['network_before'];after=capture['network_after']
        self.assertTrue(capture['wifi_initial_equals_final']);self.assertNotEqual(before['default_net_id'],after['default_net_id'])
        expected={'defaultNetwork':{'transport':'wifi','validated':True},'defaultNetworkId':before['default_net_id'],'wifiEnabled':True,'wifiConnected':True,'defaultDataSubscriptionId':'1'}
        row={'settings':EMPTYSETTINGS,'consultation_postcondition':expected,'consultation_deadline':time.monotonic()+1,'consultation_wifi_toggled':True}
        raw=projected_network(after['networks'],after['default_net_id'])
        def adb(*args,**kwargs):return subprocess.CompletedProcess(args,0,raw if args[-1]=='connectivity' else 'multi_sim_data_call=1','')
        with patch.object(g,'adb',side_effect=adb),patch.object(g,'wifi_enabled',return_value=True),patch.object(g,'set_wifi') as mutate:
            self.assertFalse(g.consultation_postcondition(row));mutate.assert_not_called()
    def test_fast_path_external_change_is_preserved_and_not_certified(self):
        row={'consultation_decision':{'route':'cellular_default'},'consultation_wifi_toggled':False}
        with patch.object(g,'consultation_postcondition',return_value=False),patch.object(g,'restore_state') as settings,patch.object(g,'set_wifi') as wifi:
            with self.assertRaisesRegex(RuntimeError,'postcondition_changed'):g.restore_lease(row)
        settings.assert_not_called();wifi.assert_not_called()
    def test_async_owned_reconnection_is_bounded_and_requires_effective_route(self):
        networks=shape['network']['networks'];cell=projected_network([networks[0]],278);wifi=projected_network(networks,279);observations=iter([cell,wifi]);counts=[]
        row={'settings':EMPTYSETTINGS,'consultation_postcondition':{'defaultNetwork':{'transport':'wifi','validated':True},'defaultNetworkId':279,'wifiEnabled':True,'wifiConnected':True,'defaultDataSubscriptionId':'1'},'consultation_wifi_toggled':True,'consultation_deadline':time.monotonic()+2}
        def adb(*args,**kwargs):
            if args[-1]=='connectivity':counts.append(1);value=next(observations)
            else:value='multi_sim_data_call=1'
            return subprocess.CompletedProcess(args,0,value,'')
        with patch.object(g,'adb',side_effect=adb),patch.object(g,'wifi_enabled',return_value=True):self.assertTrue(g.consultation_postcondition(row,wait=True))
        self.assertEqual(len(counts),2)

class KernelFd(unittest.TestCase):
    def test_actual_flock_required_not_open_path_or_other_locked_file(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(g,'ROOT',Path(tmp)):
            fd=os.open(Path(tmp)/'guard.lock',os.O_CREAT|os.O_RDWR,0o600);other=os.open(Path(tmp)/'other',os.O_CREAT|os.O_RDWR,0o600)
            try:
                self.assertFalse(g._guard_fd_is_locked(fd,os.getpid()));fcntl.flock(fd,fcntl.LOCK_EX);self.assertTrue(g._guard_fd_is_locked(fd,os.getpid()))
                same=os.open(Path(tmp)/'guard.lock',os.O_RDWR)
                try:self.assertFalse(g._guard_fd_is_locked(same,os.getpid()))
                finally:os.close(same)
                fcntl.flock(other,fcntl.LOCK_EX);self.assertFalse(g._guard_fd_is_locked(other,os.getpid()))
                code="import importlib.util,json,sys;from pathlib import Path;s=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(s);s.loader.exec_module(g);g.ROOT=Path(sys.argv[2]);print(json.dumps(g._guard_fd_is_locked(int(sys.argv[3]),int(sys.argv[4]))))"
                r=subprocess.run([sys.executable,'-c',code,str(HERE/'android-network-mutation-guard.py'),tmp,str(fd),str(os.getpid())],pass_fds=(fd,),capture_output=True,text=True,check=True);self.assertTrue(json.loads(r.stdout))
            finally:os.close(fd);os.close(other)
            self.assertFalse(g._guard_fd_is_locked(fd,os.getpid()))
    def test_restorer_reloads_journalled_child_before_waiting_for_flock(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease=Path(tmp)/('a'*32+'.json');lease.write_text('{}')
            stale={'type':'wifi_off','lease_id':'a'*32,'owner_pid':99999999,'owner_identity':{'start_ticks':'1','boot_id':'fixture'},'owner_token':'b'*32,'purpose':'maxit-deterministic','created_at':time.time(),'consultation_decision':{'route':'cellular_default'}}
            latest={**stale,'consultation_child':{'pid':55,'pgid':55,'identity':{'start_ticks':'2','boot_id':'fixture'}}};sequence=[]
            def stopped(row):
                self.assertEqual(row['consultation_child'],latest['consultation_child']);sequence.append('stop');return True
            from contextlib import contextmanager
            @contextmanager
            def lock(*args,**kwargs):
                self.assertEqual(sequence,['stop']);sequence.append('lock');yield
            with patch.object(g,'read_wifi_lease',side_effect=[stale,latest,latest]),patch.object(g,'lease_alive',return_value=False),patch.object(g,'stop_orphan_consultation_child',side_effect=stopped),patch.object(g,'mutation_lock',side_effect=lock),patch.object(g,'cleanup_consultation_channel',return_value=(True,{})),patch.object(g,'restore_lease'),patch.object(g,'write_receipt'),patch.object(g,'log_line'):
                self.assertEqual(g.run_restorer(lease,'b'*32,sleep=lambda _:None,attempts=1),'restored')
            self.assertEqual(sequence,['stop','lock'])
    def test_replaced_child_identity_never_authorizes_kill(self):
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)'],start_new_session=True)
        try:
            row={'consultation_child':{'pid':child.pid,'pgid':child.pid,'identity':{'start_ticks':'wrong','boot_id':'wrong'}}}
            self.assertFalse(g.stop_orphan_consultation_child(row));self.assertIsNone(child.poll())
        finally:os.killpg(child.pid,signal.SIGKILL);child.wait()

# Reuse only the existing fake-device fixture, not its test cases. Owner, FD, birth and cleanup are real.
ps=importlib.util.spec_from_file_location('process_fixture',HERE/'test-consultation-process-safety.py');pf=importlib.util.module_from_spec(ps);ps.loader.exec_module(pf)
class ParentDeath(unittest.TestCase):
    setUp=pf.ProcessSafety.setUp
    tearDown=pf.ProcessSafety.tearDown
    def test_parent_dies_before_journal_ready_barrier_never_executes_module(self):
        customization=self.root/'sitecustomize.py'
        customization.write_text(customization.read_text()+"""
import signal,sys

def kill_before_journal(frame,event,arg):
    if event=='call' and frame.f_code.co_name=='write_json' and 'android-network-mutation-guard.py' in frame.f_code.co_filename:
        value=frame.f_locals.get('value',{})
        if isinstance(value,dict) and value.get('consultation_child'):
            Path(os.environ['O1_TEST_BARRIER_CHILD']).write_text(str(value['consultation_child']['pid']))
            os.kill(os.getpid(),signal.SIGKILL)
    return kill_before_journal
sys.settrace(kill_before_journal)
""")
        module=self.root/'telecom/maxit_guarded_service.py';module.write_text("__import__('pathlib').Path(__import__('os').environ['O1_TEST_MODULE_MARKER']).write_text('executed')\n"+module.read_text())
        marker=self.root/'module-entered';child_marker=self.root/'barrier-child'
        proc=subprocess.Popen(self.command,env={**self.env,'O1_TEST_BARRIER_CHILD':str(child_marker),'O1_TEST_MODULE_MARKER':str(marker)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            proc.communicate(timeout=5);self.assertEqual(proc.returncode,-signal.SIGKILL);self.assertTrue(child_marker.exists());child=int(child_marker.read_text());started=time.monotonic()
            while time.monotonic()-started<6 and (self.wifi.read_text()!='on' or list((self.root/'.openclaw/network-mutation/leases').glob('*.json'))):time.sleep(.05)
            self.assertFalse(marker.exists());self.assertEqual(self.wifi.read_text(),'on');self.assertEqual(g.consultation_group_members(child),[]);self.assertEqual(list((self.root/'.openclaw/network-mutation/leases').glob('*.json')),[])
        finally:
            if proc.poll() is None:proc.kill();proc.communicate(timeout=2)
            if 'child' in locals() and g.consultation_group_members(child):os.killpg(child,signal.SIGKILL)
    def test_parent_sigkill_stops_fd_holding_child_and_existing_restorer_finishes(self):
        proc=subprocess.Popen(self.command,env={**self.env,'O1_TEST_WAIT':'20'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            limit=time.monotonic()+5;row=None
            while time.monotonic()<limit:
                for file in (self.root/'.openclaw/network-mutation/leases').glob('*.json'):
                    value=json.loads(file.read_text())
                    if value.get('consultation_child'):row=value;break
                if row:break
                time.sleep(.01)
            self.assertIsNotNone(row);self.assertEqual(self.wifi.read_text(),'off');child=row['consultation_child']['pid']
            self.assertTrue(g.process_identity(child));started=time.monotonic();proc.kill();proc.communicate(timeout=2)
            while time.monotonic()-started<6 and (self.wifi.read_text()!='on' or list((self.root/'.openclaw/network-mutation/leases').glob('*.json'))):time.sleep(.05)
            self.assertLess(time.monotonic()-started,6);self.assertEqual(self.wifi.read_text(),'on');self.assertEqual(g.consultation_group_members(child),[])
            self.assertEqual(list((self.root/'.openclaw/network-mutation/leases').glob('*.json')),[])
        finally:
            if proc.poll() is None:proc.kill();proc.communicate(timeout=2)
            if 'child' in locals() and g.consultation_group_members(child):os.killpg(child,signal.SIGKILL)

if __name__=='__main__':unittest.main()
