import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import uuid
import unittest
from unittest.mock import patch

MODULE=Path(__file__).with_name('people-trusted.py')
spec=importlib.util.spec_from_file_location('r17_people',MODULE);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
OWNER='+21610000001';OTHER='+21610000002';NEW='+21610000003'

class AllowlistTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.now=1800000000
        self.old=(m.ROOT,m.DB,m.CONTACTS,m.CONFIG,m.SESSION_DB)
        m.ROOT=self.root/'people';m.DB=m.ROOT/'directory.db';m.CONTACTS=self.root/'contacts';m.CONFIG=self.root/'config.json';m.SESSION_DB=self.root/'sessions.sqlite'
        self.cfg={'commands':{'ownerAllowFrom':['whatsapp:'+OWNER]},'channels':{'whatsapp':{'allowFrom':[OTHER,OWNER],'direct':{OTHER:{'systemPrompt':'KEEP','other':'stay'},'*':{'systemPrompt':'BASE'}}}},'unrelated':{'stay':True}}
        self.save();self.calls=[];self.service=m.Contacts(m._ExistingPeopleOwner(),clock=lambda:self.now,state_dir=self.root,owner_sender=lambda message,key: 'accepted')
        self.gw=patch.object(m,'gateway_call',side_effect=self.gateway);self.gw.start()
        self.send=patch.object(m,'whatsapp_send',return_value='safe-message-id');self.sender=self.send.start()
    def tearDown(self):
        self.gw.stop();self.send.stop();m.ROOT,m.DB,m.CONTACTS,m.CONFIG,m.SESSION_DB=self.old;self.tmp.cleanup()
    def save(self):m.CONFIG.write_text(json.dumps(self.cfg))
    def gateway(self, method, params=None, timeout_ms=7000):
        self.calls.append((method,params))
        if method=='config.get':return {'config':copy.deepcopy(self.cfg),'hash':'HASH'}
        if method=='config.patch':
            self.assertEqual(params['baseHash'],'HASH');fields=json.loads(params['raw'])['channels']['whatsapp']
            self.cfg['channels']['whatsapp'].update(fields);self.save();return {'config':copy.deepcopy(self.cfg)}
        raise AssertionError(method)
    def body(self,action,**fields):
        fields={'operationId':fields.pop('operationId',action+'-operation'),**fields};fields['requestHash']=m.request_hash(action,fields);return fields
    def confirmed(self,body,action,number=NEW,scope='standard',text='',duration=None,prepare=True):
        cid=str(uuid.UUID(m.digest(body['operationId'])[:32]));body['confirmationId']=cid
        raw={'add':number+'|'+scope+'|'+text+'|'+(str(duration) if duration else 'permanent'),'remove':number,'raise':number+'|'+scope+'|'+text,'reactivate':number+'|'+scope+'|'+text,'extend':number+'|'+(str(duration) if duration else 'permanent')}[action]
        file=self.root/'clawmobile-companion'/'runs.json';file.parent.mkdir(exist_ok=True)
        record={'id':cid,'state':'approved','consumedAt':self.now*1000,'expiresAt':(self.now+100)*1000,'intent':{'action':{'type':'whatsapp.allowlist_'+action,'reference':m.contact_id(number),'payloadHash':m.digest(raw)}}}
        file.write_text(json.dumps({'ownerConfirmations':[record]}));mutation={'raise':'scope','extend':'expiry'}.get(action,action);body['requestHash']=m.request_hash(mutation,body)
        if prepare:self.service.call('prepare',{'action':mutation,'body':body})
        record['state']='consumed';file.write_text(json.dumps({'ownerConfirmations':[record]}));return body
    def add(self,**kwargs):
        body=self.body('add',e164=NEW,contactId=m.contact_id(NEW),scope=kwargs.pop('scope','standard'),scopeText=None,durationDays=kwargs.pop('durationDays',None),notify=False,**kwargs)
        self.confirmed(body,'add',scope=body['scope'],duration=body['durationDays']);return self.service.call('add',body),body
    def test_add_preserves_all_neighbors_and_replay(self):
        before=copy.deepcopy(self.cfg);result,body=self.add();self.assertEqual(result['state'],'added');self.assertEqual(result['receipt']['version'],1)
        self.assertEqual(self.cfg['channels']['whatsapp']['allowFrom'],before['channels']['whatsapp']['allowFrom']+[NEW]);self.assertEqual(self.cfg['channels']['whatsapp']['direct'],before['channels']['whatsapp']['direct']);self.sender.assert_not_called()
        count=len(self.calls);self.assertEqual(self.service.call('add',body),result);self.assertEqual(len(self.calls),count)
        change=self.body('add',**{k:v for k,v in body.items() if k not in ('requestHash','confirmationId','notify')},notify=True)
        with self.assertRaisesRegex(m.Refused,''):self.service.call('add',change)
        self.assertEqual(len(self.calls),count)
    def test_confirmation_required_mismatch_expired_no_write(self):
        body=self.body('add',e164=NEW,scope='standard',scopeText=None,durationDays=None,notify=False)
        for mode in ('missing','mismatch','expired'):
            if mode!='missing':
                self.confirmed(body,'add',prepare=False);file=self.root/'clawmobile-companion'/'runs.json';value=json.loads(file.read_text());record=value['ownerConfirmations'][0]
                if mode=='mismatch':record['intent']['action']['payloadHash']='0'*64
                else:record['expiresAt']=self.now*1000-1
                file.write_text(json.dumps(value))
            with self.assertRaises(m.Refused):self.service.call('add',body)
        self.assertFalse(m.DB.exists());self.assertEqual(self.calls,[])
    def test_suspend_reactivate_scope_and_owner(self):
        self.add();identity=m.contact_id(NEW)
        high=self.body('scope',contactId=identity,scope='claw',scopeText=None)
        with self.assertRaises(m.Refused):self.service.call('scope',high)
        self.confirmed(high,'raise',scope='claw');self.assertEqual(self.service.call('scope',high)['state'],'updated')
        low=self.body('scope',operationId='lower',contactId=identity,scope='standard',scopeText=None);self.service.call('scope',low);self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['direct'])
        self.assertEqual(self.service.call('suspend',self.body('suspend',contactId=identity))['state'],'suspended');self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['allowFrom'])
        active=self.body('reactivate',contactId=identity);self.confirmed(active,'reactivate');self.assertEqual(self.service.call('reactivate',active)['state'],'reactivated')
        for action in ('remove','suspend','expiry'):
            with self.assertRaises(m.Refused) as e:self.service.call(action,self.body(action,operationId='owner-'+action,contactId=m.contact_id(OWNER),**({'durationDays':1} if action=='expiry' else {})))
            self.assertEqual(e.exception.code,'owner_contact_protected')
    def test_expiry_sweep_injected_clock_idempotent_and_no_write_empty(self):
        initial=self.cfg.copy();out=self.service.call('sweep',{});self.assertEqual(out['processed'],0);self.assertFalse(m.DB.exists())
        self.add(durationDays=1);self.now+=86401;row=self.service.find(m.contact_id(NEW));self.assertEqual(row['state'],'expired_pending')
        out=self.service.call('sweep',{});self.assertTrue(out['success']);self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['allowFrom']);calls=len(self.calls)
        self.service.call('sweep',{});self.assertEqual(len(self.calls),calls);self.assertEqual(self.service.history(m.contact_id(NEW))[0]['action'],'expired')
    def test_note_private_and_remove_archives_it(self):
        self.add();identity=m.contact_id(NEW);body=self.body('note',contactId=identity,text='Private note');out=self.service.call('note',body)
        self.assertEqual(self.service.call('note-get',{'contactId':identity})['text'],'Private note');self.assertNotIn('Private note',json.dumps(out));self.assertNotIn(NEW,json.dumps(self.service.history(identity)))
        remove=self.body('remove',contactId=identity);self.confirmed(remove,'remove');self.assertEqual(self.service.call('remove',remove)['state'],'removed')
        self.assertIn('Private note',self.service.context(NEW));self.assertNotIn(m.MARKER,self.service.context(NEW))
        again=self.body('remove',operationId='second-remove',contactId=identity);self.assertEqual(self.service.call('remove',again)['state'],'already_absent')
    def test_uncertain_patch_no_fallback_or_retry(self):
        def gateway(method,params=None,timeout_ms=7000):
            if method=='config.patch':raise RuntimeError('sensitive owner output')
            return self.gateway(method,params,timeout_ms)
        with patch.object(m,'gateway_call',side_effect=gateway),patch.object(m,'legacy_mutate_whatsapp') as oldfallback:
            result,body=self.add();self.assertEqual(result['state'],'indeterminate');self.assertEqual(self.service.call('add',body),result);oldfallback.assert_not_called()
        self.assertNotIn('sensitive',json.dumps(result))
    def test_safe_fallback_get_failed_before_patch(self):
        def gw(method,params=None,timeout_ms=7000):raise RuntimeError('unavailable before effect')
        def setter(path,value,old,timeout=25):
            key=path.split('.')[-1];self.assertEqual(self.cfg['channels']['whatsapp'][key],old);self.cfg['channels']['whatsapp'][key]=value;self.save()
        with patch.object(m,'gateway_call',side_effect=gw),patch.object(m,'legacy_cfg_set',side_effect=setter) as setcall:
            result,_=self.add();self.assertEqual(result['state'],'added');self.assertEqual(setcall.call_count,1)
    def test_read_only_list_and_bounds(self):
        config=m.CONFIG.read_bytes();self.service.call('list',{});self.assertEqual(m.CONFIG.read_bytes(),config);self.assertFalse(m.DB.exists());self.assertEqual(self.calls,[('config.get',{})])
        for number in ('21610000003','+216 10000003','+000'):
            body=self.body('add',e164=number,scope='standard',durationDays=None,notify=False)
            with self.assertRaises(m.Refused):self.service.call('add',body)
        self.add();identity=m.contact_id(NEW)
        with self.assertRaises(m.Refused):self.service.call('note',self.body('note',contactId=identity,text='x'*2001))
        self.assertLess(len((m.MARKER+'\n'+m.canonical(self.service.metadata(NEW))+'\n'+m.END+'\n').encode()),2048)

    def test_scope_direct_snapshot_and_confirmation_body_binding(self):
        self.add();identity=m.contact_id(NEW)
        change=self.body('scope',operationId='scope-custom',contactId=identity,scope='custom',scopeText='Project only')
        self.confirmed(change,'raise',scope='custom',text='Project only');self.service.call('scope',change)
        lower=self.body('scope',operationId='scope-claw',contactId=identity,scope='claw',scopeText=None)
        self.assertEqual(self.service.call('scope',lower)['state'],'updated')
        item=self.service.find(identity);self.assertEqual(item['scope'],'claw')
        body=self.body('scope',operationId='authority',contactId=identity,scope='standard',scopeText=None)
        body['expectedAuthority']={'present':True,'owner':False,'scope':'standard','scopeText':None,'state':'active','expiresAt':None}
        with self.assertRaises(m.Refused) as error:self.service.call('scope',body)
        self.assertEqual(error.exception.code,'operation_conflict')
        body=self.body('scope',operationId='scope-custom2',contactId=identity,scope='custom',scopeText='Project only')
        self.confirmed(body,'raise',scope='custom',text='Project only');self.service.call('scope',body)
        original=dict(body);body['confirmationId']='22222222-2222-4222-8222-222222222222';body['requestHash']=m.request_hash('scope',body)
        with self.assertRaises(m.Refused):self.service.call('scope',body)
        self.assertNotEqual(body['requestHash'],original['requestHash'])
    def test_history_cursor_and_no_private_payload(self):
        self.add();identity=m.contact_id(NEW)
        for i in range(3):self.service.call('note',self.body('note',operationId='note-'+str(i),contactId=identity,text='secret-'+str(i)))
        result=self.service.call('history',{'limit':2});self.assertEqual(len(result['items']),2);self.assertIsNotNone(result['nextBefore'])
        second=self.service.call('history',{'limit':2,'before':result['nextBefore']});self.assertEqual(len(second['items']),2)
        self.assertNotIn('secret',json.dumps(result));self.assertNotIn(NEW,json.dumps(second))
        self.assertEqual(self.service.call('get',{'contactId':identity})['historyCount'],4)
    def test_sweep_capacity_and_metadata_read_budget(self):
        m.CONTACTS.mkdir()
        for i in range(201):(m.CONTACTS/('wa_216'+str(i).zfill(8)+'.md')).write_text('not R17')
        self.assertEqual(self.service.call('sweep',{})['processed'],0)
        self.assertEqual(len(self.service.call('list',{})['items']),2);self.assertFalse(m.DB.exists())
        self.calls.clear()
        for file in m.CONTACTS.glob('*.md'):file.unlink()
        prefix=m.MARKER+'\n'+m.canonical({'state':'active','scope':'standard','scopeText':None,'expiresAt':None,'addedAt':None,'suspendedScope':None,'personId':None})+'\n'+m.END+'\n'
        (m.CONTACTS/('wa_'+NEW[1:]+'.md')).write_text(prefix+'x'*3000000)
        self.assertEqual(self.service.call('sweep',{})['processed'],0);self.assertFalse(m.DB.exists());self.assertEqual(self.calls,[])
    def test_late_patch_success_verified_once_without_legacy(self):
        def gw(method,params=None,timeout_ms=7000):
            value=self.gateway(method,params,timeout_ms)
            if method=='config.patch':raise TimeoutError()
            return value
        with patch.object(m,'gateway_call',side_effect=gw),patch.object(m,'legacy_cfg_set') as legacy:
            result,_=self.add();self.assertEqual(result['state'],'added');legacy.assert_not_called()
        self.assertEqual([method for method,params in self.calls],['config.get','config.patch','config.get'])
    def test_cas_conflict_before_effect_is_retryable(self):
        def gw(method,params=None,timeout_ms=7000):
            result=self.gateway(method,params,timeout_ms)
            if method=='config.get':result['config']['channels']['whatsapp']['allowFrom'].append('+21610000099')
            return result
        with patch.object(m,'gateway_call',side_effect=gw):result,body=self.add();self.assertEqual(result['state'],'failed')
        self.assertTrue(self.service.call('operation',{'operationId':body['operationId'],'requestHash':body['requestHash']})['retryable'])
        self.assertEqual(self.service.call('add',body)['state'],'added')

    def test_temporary_grant_crash_after_patch_retains_expiry(self):
        class Crash(BaseException):pass
        def crash_after_patch(before,after):
            self.cfg=copy.deepcopy(after);self.save();raise Crash()
        body=self.body('add',e164=NEW,contactId=m.contact_id(NEW),scope='standard',scopeText=None,durationDays=1,notify=False)
        self.confirmed(body,'add',duration=1)
        with patch.object(self.service,'patch',side_effect=crash_after_patch):
            with self.assertRaises(Crash):self.service.call('add',body)
        self.assertIn(NEW,self.cfg['channels']['whatsapp']['allowFrom']);self.assertIsNotNone(self.service.metadata(NEW)['expiresAt'])
        self.now+=86401;self.assertEqual(self.service.find(m.contact_id(NEW))['state'],'expired_pending')
        self.assertTrue(self.service.call('sweep',{})['success']);self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['allowFrom'])
    def test_sweep_no_directory_or_all_contact_rediscovery(self):
        self.add(durationDays=1);self.now+=86401
        with patch.object(self.service,'rows',side_effect=AssertionError('not allowed during metadata-only sweep')),patch.object(self.service,'directory',side_effect=AssertionError('not allowed during sweep')):
            self.assertTrue(self.service.call('sweep',{})['success'])
    def test_legacy_scope_templates_and_unknown_policy_fail_closed(self):
        prompt=m.scope_prompt('Legacy Contact','claw');self.cfg['channels']['whatsapp']['direct'][OTHER]['systemPrompt']=prompt;self.save()
        self.assertEqual(self.service.find(m.contact_id(OTHER))['scope'],'claw')
        prompt=m.scope_prompt('Legacy Contact','custom','Project only');self.cfg['channels']['whatsapp']['direct'][OTHER]['systemPrompt']=prompt;self.save()
        row=self.service.find(m.contact_id(OTHER));self.assertEqual((row['scope'],row['scopeText']),('custom','Project only'))
        self.cfg['channels']['whatsapp']['direct'][OTHER]['systemPrompt']='Unrecognized high privileges';self.save()
        self.service.call('suspend',self.body('suspend',contactId=m.contact_id(OTHER)))
        body=self.body('reactivate',contactId=m.contact_id(OTHER))
        with self.assertRaises(m.Refused) as error:self.service.call('reactivate',body)
        self.assertEqual(error.exception.code,'invalid_scope')

    def test_utf8_metadata_bound_refuses_before_effect(self):
        body=self.body('add',e164=NEW,contactId=m.contact_id(NEW),scope='custom',scopeText='😀'*500,durationDays=None,notify=False)
        self.confirmed(body,'add',scope='custom',text='😀'*500,prepare=False)
        with self.assertRaises(m.Refused) as error:self.service.call('preflight',{'action':'add','body':body})
        self.assertEqual(error.exception.code,'invalid_scope');self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['allowFrom']);self.assertFalse(m.DB.exists());self.assertFalse(m.CONTACTS.exists())
    def test_owner_permanent_noop_allowed_and_activity_without_directory(self):
        body=self.body('expiry',contactId=m.contact_id(OWNER),durationDays=None)
        self.assertEqual(self.service.call('expiry',body)['state'],'updated')
        # A real session row does not require an Android directory database.
        m.DB.unlink();self.inbound_database([])
        self.assertIsNone(self.service.find(m.contact_id(OWNER))['lastActivityAt'])

    def inbound_database(self, samples):
        fixture=json.loads((MODULE.parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/r17/inbound-schema.json').read_text())
        c=sqlite3.connect(m.SESSION_DB)
        for table in ('session_windows','transcript_events'):
            columns=fixture['tables'][table]['columns']
            c.execute('CREATE TABLE '+table+' ('+','.join(column['name']+' '+column['type'] for column in columns)+')')
        seen=set()
        for sample in samples:
            for table in ('session_windows','transcript_events'):
                row=sample[table].copy()
                if table=='session_windows':
                    if row['session_id'] in seen: continue
                    seen.add(row['session_id'])
                if table=='transcript_events': row['event_json']=json.dumps(row['event_json'])
                c.execute('INSERT INTO '+table+' ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',list(row.values()))
        c.commit();c.close()
        return fixture
    def test_inbound_read_lock_wait_is_bounded(self):
        self.inbound_database([])
        connection=sqlite3.connect(m.SESSION_DB);connection.execute('BEGIN EXCLUSIVE')
        try:
            began=time.monotonic()
            # Unknown activity stays null (contract): the list survives a locked session store.
            row=self.service.find(m.contact_id(OWNER))
            self.assertIsNone(row['lastActivityAt']);self.assertNotIn('reason',row)
            self.assertLess(time.monotonic()-began,1.8)
        finally:connection.rollback();connection.close()
        self.assertFalse(m.DB.exists());self.assertFalse(m.CONTACTS.exists())

    def test_captured_inbound_provider_timestamp_filters_and_archived(self):
        fixture=json.loads((MODULE.parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/r17/inbound-schema.json').read_text())
        samples=copy.deepcopy(fixture['sampleRows'])
        # Reuse the captured rows/columns; only contact identity is generated.
        for sample in samples: sample['session_windows']['session_key']='agent:main:whatsapp:direct:'+OWNER
        self.inbound_database(samples)
        expected=max(sample['transcript_events']['event_json']['message']['timestamp'] for sample in samples)
        row=self.service.find(m.contact_id(OWNER));self.assertEqual(row['lastActivityAt'],m.utc(expected/1000));self.assertNotIn('reason',row)
        c=sqlite3.connect(m.SESSION_DB);session=samples[0]['session_windows']['session_id']
        # Newer assistant/heartbeat/other-channel timestamps are not received messages.
        for seq,message in [(100,{'role':'assistant','timestamp':expected+100000,'__openclaw':{'transport':{'channel':'whatsapp'}}}),(101,{'role':'user','timestamp':expected+200000}),(102,{'role':'user','timestamp':expected+300000,'__openclaw':{'transport':{'channel':'slack'}}})]:
            c.execute('INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)',(session,seq,json.dumps({'type':'message','message':message}),expected+seq))
        c.commit();c.close();self.assertEqual(self.service.find(m.contact_id(OWNER))['lastActivityAt'],m.utc(expected/1000))
        c=sqlite3.connect(m.SESSION_DB);c.execute('INSERT INTO transcript_events(session_id,seq,event_json,event_zstd,created_at) VALUES(?,?,NULL,?,?)',(session,103,b'compressed-fixture',expected+400000));c.commit();c.close()
        row=self.service.find(m.contact_id(OWNER));self.assertIsNone(row['lastActivityAt']);self.assertEqual(row['reason'],'archived_history')
        self.assertFalse(m.DB.exists());self.assertFalse(m.CONTACTS.exists())

    def test_prepared_consume_failure_same_body_retry_and_unique_confirmation(self):
        body=self.body('add',e164=NEW,contactId=m.contact_id(NEW),scope='standard',scopeText=None,durationDays=None,notify=False)
        self.confirmed(body,'add')
        # Confirmation has been consumed; failed context write happens before CAS.
        with patch.object(self.service,'write_context',side_effect=OSError()):result=self.service.call('add',body)
        self.assertEqual(result['state'],'failed');self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['allowFrom'])
        status=self.service.call('operation',{'operationId':body['operationId'],'requestHash':body['requestHash']});self.assertTrue(status['retryable'])
        prepared=self.service.call('prepare',{'action':'add','body':body});self.assertTrue(prepared['allowConsumedRetry']);self.assertEqual(prepared['confirmationClaim']['requestHash'],body['requestHash'])
        self.assertEqual(self.service.call('add',body)['state'],'added')
        duplicate={**body,'operationId':'new-operation'};duplicate['requestHash']=m.request_hash('add',duplicate)
        # A second distinct operation cannot reuse the already consumed proof,
        # even when targeting another effect with the same biometric intent.
        self.cfg['channels']['whatsapp']['allowFrom'].remove(NEW);self.save()
        with self.assertRaises(m.Refused) as error:self.service.call('prepare',{'action':'add','body':duplicate})
        self.assertEqual(error.exception.code,'confirmation_mismatch')
    def test_preflight_no_writes_or_consumed_proof_requirement(self):
        body=self.body('add',e164=NEW,contactId=m.contact_id(NEW),scope='standard',scopeText=None,durationDays=None,notify=False)
        self.assertTrue(self.service.call('preflight',{'action':'add','body':body})['success']);self.assertFalse(m.DB.exists());self.assertFalse(m.CONTACTS.exists());self.assertEqual(self.calls,[])

    def test_expiry_boundary_strictly_after_deadline(self):
        self.add(durationDays=1)
        # Settle the independent grant notice before proving expiry is write-free.
        self.service.deliver_owner_change();self.now+=86400
        self.assertEqual(self.service.find(m.contact_id(NEW))['state'],'active')
        before=(m.DB.read_bytes(),m.CONFIG.read_bytes(),self.service.context(NEW))
        self.assertEqual(self.service.call('sweep',{})['processed'],0)
        self.assertEqual((m.DB.read_bytes(),m.CONFIG.read_bytes(),self.service.context(NEW)),before)
        self.now+=0.001;self.assertEqual(self.service.find(m.contact_id(NEW))['state'],'expired_pending')
        self.assertTrue(self.service.call('sweep',{})['success']);self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['allowFrom'])

    def test_delete_suspended_removes_entire_rule_block_and_archives_remainder(self):
        self.add(scope='claw');identity=m.contact_id(NEW)
        self.service.call('note',self.body('note',contactId=identity,text='Private remainder'))
        self.assertTrue(self.service.context(NEW).endswith('Private remainder'))
        self.assertNotIn('samantha-private-note',self.service.context(NEW))
        self.service.call('suspend',self.body('suspend',contactId=identity))
        remove=self.body('remove',contactId=identity);self.confirmed(remove,'remove')
        self.assertEqual(self.service.call('remove',remove)['state'],'removed')
        self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['direct'])
        self.assertIsNone(self.service.metadata(NEW));self.assertIn('Private remainder',self.service.context(NEW))
        self.assertIn('Private note archive',self.service.context(NEW))
        with self.assertRaises(m.Refused):self.service.find(identity)
    def test_sweep_uncertain_new_attempt_after_fresh_read(self):
        self.add(durationDays=1);self.now+=86401
        patches=0
        def gateway(method,params=None,timeout_ms=7000):
            nonlocal patches
            if method=='config.patch':
                patches+=1
                if patches==1: raise TimeoutError()
            return self.gateway(method,params,timeout_ms)
        with patch.object(m,'gateway_call',side_effect=gateway):
            first=self.service.call('sweep',{});self.assertFalse(first['success']);self.assertEqual(patches,1)
            # The uncertain attempt keeps its own receipt; the next pass re-reads allowFrom and uses a new attempt id.
            self.assertIn(NEW,self.cfg['channels']['whatsapp']['allowFrom'])
            second=self.service.call('sweep',{});self.assertTrue(second['success']);self.assertEqual(patches,2)
        self.assertIsNone(self.service.metadata(NEW));self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['direct'])
        self.assertNotIn(m.contact_id(NEW),[row['contactId'] for row in self.service.rows()])
        self.assertEqual(self.service.read_operation('expire:'+m.digest(NEW+'\0'+m.utc(1800000000+86400))[:40]+':0')['state'],'indeterminate')
        self.assertEqual(self.service.read_operation('expire:'+m.digest(NEW+'\0'+m.utc(1800000000+86400))[:40]+':1')['state'],'removed')
        events=self.service.call('history',{})['items'];self.assertEqual([e['action'] for e in events].count('expired'),1)
        self.assertTrue(all('scope' in e and 'durationDays' in e for e in events))
        self.assertEqual(events[0]['durationDays'],1)
    def test_history_pending_and_failed_are_not_terminal_events(self):
        _,body=self.add();identity=m.contact_id(NEW)
        self.service.reserve('pending-note',identity,'0'*64,event='note_updated')
        self.assertEqual(len(self.service.call('history',{})['items']),1)
        self.assertEqual(self.service.history_count(identity),1)

    def test_sweep_rotates_bounded_pages_beyond_200(self):
        self.add(durationDays=1);self.now+=86401
        target=self.service.path(NEW)
        for i in range(205):
            (m.CONTACTS/('wa_100'+str(i).zfill(8)+'.md')).write_text('not R17')
        self.now-=self.now%120  # first page excludes NEW
        self.now+=120  # remain after the grant deadline
        first=self.service.call('sweep',{})
        self.assertFalse(first['scanComplete']);self.assertEqual(first['state'],'partial')
        self.assertIn(NEW,self.cfg['channels']['whatsapp']['allowFrom'])
        self.now+=60;second=self.service.call('sweep',{})
        self.assertEqual(second['processed'],1);self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['allowFrom'])
        self.assertIsNone(self.service.metadata(NEW))
    def test_delete_expired_removes_metadata_and_all_direct_fields(self):
        self.add(durationDays=1);self.now+=86401
        self.cfg['channels']['whatsapp']['direct'][NEW]={'systemPrompt':'opaque','extra':'managed'};self.save()
        body=self.body('remove',contactId=m.contact_id(NEW));self.confirmed(body,'remove')
        self.assertEqual(self.service.call('remove',body)['state'],'removed')
        self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['direct']);self.assertIsNone(self.service.metadata(NEW))

    def test_suspended_expiry_sweeps_and_target_detail_beyond_page(self):
        self.add(durationDays=1);identity=m.contact_id(NEW)
        self.service.call('suspend',self.body('suspend',contactId=identity))
        for i in range(205):(m.CONTACTS/('wa_100'+str(i).zfill(8)+'.md')).write_text('not R17')
        self.assertEqual(self.service.find(identity)['state'],'suspended')
        self.now+=86401;self.now-=self.now%120;self.now+=180
        self.assertEqual(self.service.call('sweep',{})['processed'],1)
        self.assertIsNone(self.service.metadata(NEW));self.assertNotIn(NEW,self.cfg['channels']['whatsapp']['direct'])
        again=self.body('remove',operationId='retired-beyond-page',contactId=identity)
        self.assertEqual(self.service.call('remove',again)['state'],'already_absent')

    def test_note_remainder_long_read_is_explicit_partial(self):
        self.add();metadata=self.service.metadata(NEW)
        self.service.write_context(NEW,metadata,note='legacy\n'+('x'*2500))
        result=self.service.call('note-get',{'contactId':m.contact_id(NEW)})
        self.assertEqual(result['state'],'partial');self.assertTrue(result['truncated']);self.assertEqual(len(result['text']),2000)
        self.assertTrue(result['text'].startswith('legacy\n'))

if __name__=='__main__':unittest.main()
