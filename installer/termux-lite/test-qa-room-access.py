"""QA delegated authority fixtures: local files only, never contacts/ADB/Gateway."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from contextlib import nullcontext
from types import SimpleNamespace
import fcntl
import os
import hashlib
import sqlite3
import sys
import time

spec=importlib.util.spec_from_file_location('qa_people',Path(__file__).with_name('people-trusted.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NUMBER='+21610000009'  # Explicitly synthetic, never a recipient.
APP={'app_id':'demo','app_name':'Demo QA','package':'test.claw.qa.fixture','environment':'recette','allow_writes':False}

class QaRoomAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.original=(m.CONTACTS,m.CONFIG,m.ROOT,m.DB)
        m.CONTACTS=self.root/'contacts';m.CONTACTS.mkdir();m.CONFIG=self.root/'config.json'
        m.ROOT=self.root/'people';m.DB=m.ROOT/'directory.db'
        self.service=m.Contacts(m._ExistingPeopleOwner(),clock=lambda:1800000000,state_dir=self.root)
        self.metadata={'state':'active','scope':'standard','scopeText':None,'expiresAt':None,
            'addedAt':'2026-10-18T12:00:00Z','suspendedScope':None,'personId':None,
            'rooms':['conversation','qa'],'qaApps':[dict(APP)]}
        self.identity=m.contact_id(NUMBER)
        self.cfg={'commands':{'ownerAllowFrom':['whatsapp:+21610000001']},'channels':{'whatsapp':{'allowFrom':[NUMBER]}},'bindings':[{
            'agentId':'contacts-qa','comment':m.ROOM_TAG+self.identity,
            'match':{'channel':'whatsapp','accountId':'*','peer':{'kind':'direct','id':NUMBER}}}]}
        self.persist()
        self.gateway=patch.object(m,'gateway_call',side_effect=lambda *args,**kwargs:{'config':self.cfg})
        self.gateway.start()

    def tearDown(self):
        self.gateway.stop();m.CONTACTS,m.CONFIG,m.ROOT,m.DB=self.original;self.tmp.cleanup()

    def persist(self):
        m.CONFIG.write_text(json.dumps(self.cfg))
        self.service.path(NUMBER).write_text(m.MARKER+'\n'+m.canonical(self.metadata)+'\n'+m.END+'\nPrivate note never returned\n')

    def read(self,**changes):
        return self.service.qa_scope_read({'schema_version':1,'requester_hash':self.identity,'app_id':'demo',**changes})

    def denied(self,value):
        self.assertEqual(value,{'ok':False,'error':{'code':'qa_scope_unavailable'}})

    def test_live_authority_comes_from_current_private_contact(self):
        with (patch.object(self.service,'directory',side_effect=AssertionError('no full contact list')),
              patch.object(m,'gateway_call',side_effect=AssertionError('no Gateway'))):
            result=self.read()
        self.assertTrue(result['ok']);scope=result['scope']
        self.assertEqual(scope['requester_hash'],self.identity)
        self.assertEqual(scope['package'],APP['package']);self.assertFalse(scope['allow_writes'])
        self.assertRegex(scope['grant_revision'],r'^[a-f0-9]{64}$')
        self.assertNotIn(NUMBER,json.dumps(result));self.assertNotIn('Private note',json.dumps(result))

    def test_revocation_and_expiry_are_reread_without_cached_admission(self):
        self.assertTrue(self.read()['ok'])
        self.cfg['channels']['whatsapp']['allowFrom']=[];self.persist();self.denied(self.read())
        self.cfg['channels']['whatsapp']['allowFrom']=[NUMBER]
        self.metadata['expiresAt']=m.utc(1800000000);self.persist();self.denied(self.read())
        self.metadata['expiresAt']=m.utc(1800000001);self.persist();self.assertTrue(self.read()['ok'])
        self.metadata['state']='suspended';self.persist();self.denied(self.read())

    def test_session_or_foreign_app_does_not_grant_authority(self):
        self.denied(self.read(app_id='foreign'))
        self.denied(self.read(requester_hash='wa-'+'0'*16))
        self.cfg['bindings']=[];self.persist();self.denied(self.read())

    def test_exact_concrete_binding_required(self):
        original=copy.deepcopy(self.cfg['bindings'][0])
        for change in ('agent','group','foreign','duplicate'):
            self.cfg['bindings']=[copy.deepcopy(original)]
            if change=='agent':self.cfg['bindings'][0]['agentId']='contacts'
            elif change=='group':self.cfg['bindings'][0]['match']['peer']['kind']='group'
            elif change=='foreign':self.cfg['bindings'][0]['match']['peer']['id']='+21610000008'
            else:self.cfg['bindings'].append(copy.deepcopy(original))
            self.persist();self.denied(self.read())

    def test_public_fields_cannot_choose_role_or_source(self):
        for extra in ({'owner':True},{'path':'anything'},{'grants':[APP]},{'schema_version':True}):
            self.denied(self.read(**extra))

    def test_header_and_symlink_fail_closed(self):
        self.service.path(NUMBER).write_text(m.MARKER+'\n'+json.dumps({'qaApps':[APP]})+'\n'+m.END)
        self.denied(self.read())
        self.service.path(NUMBER).unlink();self.service.path(NUMBER).symlink_to(m.CONFIG)
        self.denied(self.read())

    def test_multi_app_names_are_private_ingress_only(self):
        self.metadata['qaApps'].append({**APP,'app_id':'second','app_name':'Second QA','package':'test.claw.qa.other'})
        self.persist()
        result=self.service.qa_ingress_read({'requester_hash':self.identity})
        self.assertTrue(result['ok']);self.assertEqual(len(result['grants']),2)
        self.assertEqual({g['grant_revision'] for g in result['grants']},{self.read()['scope']['grant_revision']})
        self.assertNotIn(NUMBER,json.dumps(result));self.assertNotIn('app_name',self.read()['scope'])

    def test_actual_contact_writer_retains_all_twelve_bounded_app_grants(self):
        self.metadata['qaApps']=[{**APP,'app_id':f'app{i}','app_name':f'Application de recette numéro {i}',
            'package':f'test.claw.qa.fixture.a{i}'} for i in range(12)]
        self.assertGreater(len(json.dumps(self.metadata).encode()),2048)
        self.service.write_context(NUMBER,self.metadata)
        observed=self.service.metadata(NUMBER)
        self.assertEqual(len(observed['qaApps']),12)
        self.assertLess(len(self.service.context(NUMBER).encode()),m.CONTACT_HEADER_BYTES)
        self.assertTrue(self.service.qa_scope_read({'schema_version':1,'requester_hash':self.identity,'app_id':'app11'})['ok'])

    def test_changed_grant_changes_revision_even_in_same_room(self):
        previous=self.read()['scope']['grant_revision']
        self.metadata['qaApps'][0]['allow_writes']=True;self.persist()
        self.assertNotEqual(previous,self.read()['scope']['grant_revision'])

    def test_new_app_and_write_raise_in_existing_room_require_biometrics(self):
        for apps in ([{**APP,'allow_writes':True}], [APP,{**APP,'app_id':'second','package':'test.claw.qa.other'}]):
            body={'operationId':'qa-grant-fixture','contactId':self.identity,'rooms':['conversation','qa'],'qaApps':apps,
                  'expectedQaRevision':self.read()['scope']['grant_revision']}
            body['requestHash']=m.request_hash('rooms',body)
            with self.subTest(apps=apps),self.assertRaises(m.Refused) as raised:
                self.service.mutate('rooms',body,phase='prepare')
            self.assertEqual(raised.exception.code,'confirmation_required')
            self.assertEqual(self.service.metadata(NUMBER)['qaApps'],[APP])
            self.assertFalse(m.DB.exists())

    def test_stale_authority_refused_before_any_confirmation_or_write(self):
        body={'operationId':'qa-stale-fixture','contactId':self.identity,'rooms':['conversation','qa'],'qaApps':[APP],
            'expectedAuthority':{'present':True,'owner':False,'scope':'standard','scopeText':None,'state':'active','expiresAt':None,'qaRevision':'0'*64}}
        body['requestHash']=m.request_hash('rooms',body)
        with (patch.object(self.service,'confirmation',side_effect=AssertionError('must refuse before confirmation')),
              self.assertRaises(m.Refused) as raised):
            self.service.mutate('rooms',body,phase='prepare')
        self.assertEqual(raised.exception.code,'operation_conflict');self.assertFalse(m.DB.exists())

    def test_stale_or_legacy_form_cannot_erase_unseen_qa_grants(self):
        revision=self.read()['scope']['grant_revision']
        for supplied in (None,'0'*64,revision):
            self.metadata['qaApps'][0]['allow_writes']=True;self.persist()
            body={'operationId':'qa-form-fixture','contactId':self.identity,'rooms':['conversation']}
            if supplied is not None:body['expectedQaRevision']=supplied
            body['requestHash']=m.request_hash('rooms',body)
            before=self.service.path(NUMBER).read_bytes()
            with (self.subTest(revision=supplied),
                  patch.object(self.service,'confirmation',side_effect=AssertionError('before confirmation')),
                  self.assertRaises(m.Refused) as raised):
                self.service.mutate('rooms',body,phase='prepare')
            self.assertEqual(raised.exception.code,'operation_conflict')
            self.assertEqual(self.service.path(NUMBER).read_bytes(),before)
            self.assertFalse(m.DB.exists())

    def test_current_form_may_prepare_explicit_qa_removal(self):
        body={'operationId':'qa-remove-fixture','contactId':self.identity,'rooms':['conversation'],
              'expectedQaRevision':self.read()['scope']['grant_revision']}
        body['requestHash']=m.request_hash('rooms',body)
        result=self.service.mutate('rooms',body,phase='preflight')
        self.assertTrue(result['success'])
        self.assertEqual(self.service.metadata(NUMBER)['qaApps'],[APP])
        self.assertFalse(m.DB.exists())

    def test_normalization_is_bounded_closed_and_deterministic(self):
        self.assertEqual(m.normalize_qa_apps([{**APP,'app_id':'z'},APP]),[APP,{**APP,'app_id':'z'}])
        for invalid in ([APP,APP],[{**APP,'allow_writes':1}],[{**APP,'token':'secret'}],
                [{**APP,'package':'com.android.settings'}],[{**APP,'environment':'production admin'}],
                [{**APP,'app_name':'login@example.test'}],[{**APP,'app_name':'OTP 123456'}],
                [{**APP,'app_id':str(i)} for i in range(13)]):
            with self.subTest(invalid=invalid),self.assertRaises(m.Refused):m.normalize_qa_apps(invalid)

    def test_legacy_capture_does_not_create_qa_grant(self):
        capture=Path(__file__).parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11b/h10/whatsapp.allowlist.json'
        observed=json.loads(capture.read_text())
        self.assertEqual(observed['_capture']['route'],'/v1/whatsapp/allowlist')
        self.assertTrue(all(not row.get('qaApps') for row in observed['response']['items']))
        self.metadata.pop('qaApps');self.metadata['rooms']=['conversation'];self.persist();self.denied(self.read())

    def test_queue_tick_missing_owner_remains_not_ready_without_dispatch(self):
        with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace()):
            self.assertEqual(m.qa_queue_tick(),{'state':'NOT_READY','dispatched':0,'waiting':0})

    def test_queue_tick_never_calls_owner_without_deployment_lease(self):
        with patch.object(m,'qa_owner_read_lease',side_effect=BlockingIOError()),patch.object(m,'qa_owner_module') as owner:
            self.assertEqual(m.qa_queue_tick()['state'],'NOT_READY');owner.assert_not_called()

    def test_queue_tick_uncertain_callback_has_no_false_no_effect_receipt(self):
        callback=lambda: (_ for _ in ()).throw(RuntimeError('synthetic-private-exception'))
        with patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace(queue_tick=callback)):
            value=m.qa_queue_tick()
        self.assertEqual(value['state'],'VERIFY_REQUIRED')
        self.assertNotIn('synthetic-private-exception',json.dumps(value))

    def test_queue_tick_closed_receipt_rejects_bool_count_and_extra_data(self):
        for result in ({'state':'STARTED','dispatched':True,'waiting':0},
                       {'state':'IDLE','dispatched':1,'waiting':0},
                       {'state':'STARTED','dispatched':1,'waiting':0,'private':'omitted'}):
            with self.subTest(result=result),patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),patch.object(m,'qa_owner_module',return_value=SimpleNamespace(queue_tick=lambda:result)):
                self.assertEqual(m.qa_queue_tick()['state'],'VERIFY_REQUIRED')

    def test_owner_loading_holds_the_existing_q12_shared_lock(self):
        home=self.root/'home';lock=home/'.openclaw/deploys/companion-deploy.lock'
        lock.parent.mkdir(parents=True);lock.touch(mode=0o600)
        with patch.object(m,'HOME',home):
            other=os.open(lock,os.O_RDONLY)
            try:
                with m.qa_owner_read_lease():
                    with self.assertRaises(BlockingIOError):fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
                fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(other)

    def test_private_import_cannot_select_an_arbitrary_module(self):
        with self.assertRaises(ValueError):m.qa_owner_module('subprocess')

    def delivery_request(self,**changes):
        return {'schema_version':1,'run_id':'qa_fixture','requester_hash':self.identity,
                'app_id':'demo','event':'started',**changes}

    def delivery_payload(self):
        return {'scope':self.read()['scope'],'message':'La campagne de tests a commencé.',
                'delivery_key':'qa-delivery-'+'a'*64}

    def deliver(self,request=None,payload=None):
        callback=payload if callable(payload) else lambda request:payload or self.delivery_payload()
        def owner(name):
            return SimpleNamespace(requester_payload=callback) if name=='qa_testing.notifications' else SimpleNamespace(run_path=lambda run_id:self.root/'campaign')
        with (patch.object(m,'Contacts',return_value=self.service),
              patch.object(m,'qa_owner_read_lease',return_value=nullcontext()),
              patch.object(m,'qa_owner_module',side_effect=owner),
              patch.dict(os.environ,{'OPENCLAW_STATE_DIR':str(self.root/'installed')})):
            return m.qa_deliver(request or self.delivery_request())

    def test_requester_delivery_uses_current_recipient_and_existing_idempotency(self):
        with patch.object(m,'gateway_call',return_value={'channel':'whatsapp','messageId':'SYNTHETIC_MID'}) as send:
            first=self.deliver();second=self.deliver()
        self.assertEqual(first,{'state':'ACCEPTED','message_id':'SYNTHETIC_MID'})
        self.assertEqual(first,second);self.assertEqual(send.call_count,1)
        method,params=send.call_args.args;self.assertEqual(method,'send');self.assertEqual(params['to'],NUMBER)
        self.assertNotIn(NUMBER,json.dumps(first));self.assertNotIn('campagne',json.dumps(first))

    def test_delivery_rereads_revocation_after_owner_preparation(self):
        payload=self.delivery_payload()
        def revoke(request):
            self.metadata['state']='suspended';self.persist();return payload
        with patch.object(m,'whatsapp_send') as send:
            result=self.deliver(payload=revoke)
        self.assertEqual(result,{'state':'NOT_SENT','reason':'qa_scope_unavailable'});send.assert_not_called()

    def test_delivery_document_missing_owner_manifest_is_refused_before_reservation(self):
        with patch.object(m,'reserve_send') as reserve,patch.object(m,'whatsapp_send') as send:
            result=self.deliver(self.delivery_request(event='finished',artifact_id='report'))
        self.assertEqual(result,{'state':'NOT_SENT','reason':'qa_delivery_owner_unavailable'})
        reserve.assert_not_called();send.assert_not_called();self.assertFalse(m.DB.exists())

    def test_delivery_unknown_is_not_retried_and_exception_is_not_reflected(self):
        with patch.object(m,'gateway_call',side_effect=RuntimeError('SYNTHETIC_PRIVATE_FAILURE')) as send:
            first=self.deliver();second=self.deliver()
        self.assertEqual(first,{'state':'UNKNOWN','reason':'qa_delivery_receipt_unconfirmed'})
        self.assertEqual(first,second);self.assertEqual(send.call_count,1)
        self.assertNotIn('SYNTHETIC_PRIVATE_FAILURE',json.dumps(first))

    def test_delivery_caller_cannot_choose_content_recipient_or_path(self):
        with patch.object(m,'whatsapp_send') as send:
            for extra in ({'to':NUMBER},{'message':'arbitrary'},{'path':'/private'},
                          {'schema_version':True},{'artifact_id':'report'}):
                result=self.deliver(self.delivery_request(**extra))
                self.assertEqual(result['state'],'NOT_SENT')
            payload=self.delivery_payload();payload['scope']={**payload['scope'],'requester_hash':'wa-'+'0'*16}
            self.assertEqual(self.deliver(payload=payload)['state'],'NOT_SENT')
        send.assert_not_called()

    def test_delivery_receipts_are_bounded_without_forgetting_uncertain_sends(self):
        connection=m.connect();limit=m.QA_DELIVERY_RECEIPT_LIMIT
        connection.executemany('INSERT INTO send_receipts VALUES(?,?,?,?,?,?,?)',
            [('qa-delivery-'+format(i,'064x'),NUMBER,'fixture','uncertain',None,1,1) for i in range(limit)])
        connection.commit();connection.close()
        with patch.object(m,'gateway_call') as send:
            result=self.deliver()
        self.assertEqual(result,{'state':'NOT_SENT','reason':'qa_delivery_capacity_reached'})
        send.assert_not_called()
        connection=m.connect()
        self.assertEqual(connection.execute('SELECT COUNT(*) FROM send_receipts').fetchone()[0],limit)
        connection.close()

    def test_delivery_accepts_a_narrower_campaign_binding_but_never_broader(self):
        payload=self.delivery_payload();payload['scope']['allow_writes']=True
        with patch.object(m,'whatsapp_send') as send:
            self.assertEqual(self.deliver(payload=payload)['state'],'NOT_SENT');send.assert_not_called()
        self.metadata['qaApps'][0]['allow_writes']=True;self.persist()
        payload=self.delivery_payload();payload['scope']['allow_writes']=False
        with patch.object(m,'whatsapp_send',return_value='SYNTHETIC_MID') as send:
            self.assertEqual(self.deliver(payload=payload)['state'],'ACCEPTED');send.assert_called_once()

    def document_payload(self):
        # Synthetic already-audited bytes exercise the People integrity boundary;
        # real XLSX/ZIP redaction is covered by the QA producer's own fixtures.
        content=b'PK-SYNTHETIC-OWNER-AUDITED-REPORT'
        directory=self.root/'campaign';directory.mkdir(exist_ok=True)
        path=directory/'Claw_QA_Rapport.xlsx';path.write_bytes(content)
        payload=self.delivery_payload();payload['artifact']={'artifact_id':'report','path':str(path),
            'filename':path.name,'mime_type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'sha256':hashlib.sha256(content).hexdigest(),'size_bytes':len(content),'report_version':1}
        helper=self.root/'installed/extensions/openclaw-plugin-mobile-ui/dist/companion/officialGatewayOwner.js'
        helper.parent.mkdir(parents=True,exist_ok=True);helper.touch()
        return payload,content

    def test_document_delivery_serializes_staging_and_cleans_only_after_acceptance(self):
        payload,content=self.document_payload();request=self.delivery_request(event='finished',artifact_id='report')
        operations=[]
        def sdk(operation,document,**options):
            operations.append(operation);self.assertEqual(document['content'],content)
            # The same existing SQLite transaction protects materialization and
            # cleanup, while a second connection proves the write lock is held.
            other=sqlite3.connect(m.DB,timeout=0)
            try:
                with self.assertRaises(sqlite3.OperationalError):other.execute('BEGIN IMMEDIATE')
            finally:other.close()
            if operation=='cleanup':return {'state':'REMOVED','id':document['id'],'sha256':document['sha256']}
            return {'state':'STAGED','id':'SYNTHETIC_REPORT.xlsx','path':str(self.root/'SYNTHETIC_REPORT.xlsx'),
                    'size':len(content),'sha256':document['sha256'],'contentType':document['contentType']}
        def gateway(method,params,**options):
            other=sqlite3.connect(m.DB,timeout=0);other.execute('BEGIN IMMEDIATE');other.rollback();other.close()
            self.assertTrue(params['forceDocument']);self.assertEqual(params['filename'],'Claw_QA_Rapport.xlsx')
            self.assertIn('mediaUrl',params);self.assertNotIn('buffer',params)
            return {'channel':'whatsapp','messageId':'SYNTHETIC_DOCUMENT_MID'}
        with patch.object(m,'qa_document_sdk',side_effect=sdk),patch.object(m,'gateway_call',side_effect=gateway) as send:
            first=self.deliver(request,payload);second=self.deliver(request,payload)
        self.assertEqual(first,second);self.assertEqual(first['state'],'ACCEPTED')
        self.assertEqual(operations,['stage','cleanup']);self.assertEqual(send.call_count,1)
        self.assertNotIn(str(self.root),json.dumps(first))

    def test_changed_report_bytes_or_foreign_path_cannot_reach_reservation(self):
        payload,content=self.document_payload();request=self.delivery_request(event='finished',artifact_id='report')
        Path(payload['artifact']['path']).write_bytes(content+b'changed')
        with patch.object(m,'reserve_send') as reserve:
            self.assertEqual(self.deliver(request,payload)['state'],'NOT_SENT');reserve.assert_not_called()
        payload,content=self.document_payload()
        foreign=self.root/'outside.xlsx';foreign.write_bytes(content)
        payload['artifact'].update(path=str(foreign),filename=foreign.name)
        with patch.object(m,'reserve_send') as reserve:
            self.assertEqual(self.deliver(request,payload)['state'],'NOT_SENT');reserve.assert_not_called()

    def test_unknown_document_is_retained_and_never_staged_or_sent_again(self):
        payload,content=self.document_payload();request=self.delivery_request(event='finished',artifact_id='report')
        staged={'state':'STAGED','id':'SYNTHETIC_REPORT.xlsx','path':str(self.root/'SYNTHETIC_REPORT.xlsx'),
                'size':len(content),'sha256':payload['artifact']['sha256'],'contentType':payload['artifact']['mime_type']}
        with patch.object(m,'qa_document_sdk',return_value=staged) as sdk,patch.object(m,'gateway_call',side_effect=TimeoutError()) as send:
            first=self.deliver(request,payload);second=self.deliver(request,payload)
        self.assertEqual(first,second);self.assertEqual(first['state'],'UNKNOWN')
        self.assertEqual(sdk.call_count,1);self.assertEqual(sdk.call_args.args[0],'stage');self.assertEqual(send.call_count,1)

    def test_real_sdk_helper_pipe_keeps_document_bytes_out_of_argv(self):
        payload,content=self.document_payload()
        node=self.root/'.openclaw-android/bin/node';node.parent.mkdir(parents=True);node.symlink_to(sys.executable)
        helper=self.root/'installed/extensions/openclaw-plugin-mobile-ui/dist/companion/officialGatewayOwner.js'
        helper.write_text('''import hashlib,json,sys
meta=json.loads(sys.stdin.buffer.readline(2049));body=sys.stdin.buffer.read()
assert len(sys.argv)==2
assert 'PK-SYNTHETIC' not in json.dumps(sys.argv)
assert len(body)==meta['size'] and hashlib.sha256(body).hexdigest()==meta['sha256']
print(json.dumps({'state':'STAGED','id':'fixture.xlsx','path':'/synthetic-sdk-outbound/fixture.xlsx','size':meta['size'],'sha256':meta['sha256'],'contentType':meta['contentType']}))
''')
        with (patch.object(m,'HOME',self.root),patch.dict(os.environ,{'OPENCLAW_STATE_DIR':str(self.root/'installed')}),
              patch.object(m,'qa_owner_module',return_value=SimpleNamespace(run_path=lambda rid:self.root/'campaign'))):
            document=m.qa_document_read(payload['artifact'],'qa_fixture')
            value=m.qa_document_sdk('stage',document,timeout=1)
        self.assertEqual(value['state'],'STAGED');self.assertEqual(value['sha256'],payload['artifact']['sha256'])

    def test_sdk_helper_output_and_time_are_bounded_before_json_collection(self):
        payload,content=self.document_payload()
        node=self.root/'.openclaw-android/bin/node';node.parent.mkdir(parents=True);node.symlink_to(sys.executable)
        helper=self.root/'installed/extensions/openclaw-plugin-mobile-ui/dist/companion/officialGatewayOwner.js'
        document={'filename':'Claw_QA_Rapport.xlsx','contentType':payload['artifact']['mime_type'],
                  'sha256':payload['artifact']['sha256'],'size':len(content),'content':content}
        with patch.object(m,'HOME',self.root),patch.dict(os.environ,{'OPENCLAW_STATE_DIR':str(self.root/'installed')}):
            helper.write_text('import sys\nsys.stdout.write("X"*1000000)\nsys.stdout.flush()\n')
            with self.assertRaises(ValueError):m.qa_document_sdk('stage',document,timeout=1)
            helper.write_text('import time\ntime.sleep(5)\n')
            start=time.monotonic()
            with self.assertRaises(TimeoutError):m.qa_document_sdk('stage',document,timeout=.05)
            self.assertLess(time.monotonic()-start,1)

    def test_authority_is_reread_after_document_staging_before_the_gateway_effect(self):
        payload,content=self.document_payload();request=self.delivery_request(event='finished',artifact_id='report')
        def sdk(operation,document,**options):
            self.metadata['state']='suspended';self.persist()
            return {'state':'STAGED','id':'fixture.xlsx','path':str(self.root/'fixture.xlsx'),
                    'size':len(content),'sha256':document['sha256'],'contentType':document['contentType']}
        with patch.object(m,'qa_document_sdk',side_effect=sdk),patch.object(m,'gateway_call') as send:
            result=self.deliver(request,payload)
        self.assertEqual(result,{'state':'NOT_SENT','reason':'qa_scope_unavailable'});send.assert_not_called()

    def test_slow_payload_does_not_start_a_sender_after_the_shared_deadline(self):
        clock=[0.0];payload=self.delivery_payload()
        def delayed(request):clock[0]=19.;return payload
        with (patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),
              patch.object(m,'reserve_send') as reserve,patch.object(m,'gateway_call') as send):
            result=self.deliver(payload=delayed)
        self.assertEqual(result,{'state':'NOT_SENT','reason':'qa_delivery_deadline_exceeded'})
        reserve.assert_not_called();send.assert_not_called()

    def test_only_a_proved_pre_stage_refusal_allows_an_explicit_retry(self):
        payload,content=self.document_payload();request=self.delivery_request(event='finished',artifact_id='report')
        calls=[]
        def sdk(operation,document,**options):
            calls.append(operation)
            if len(calls)==1:raise m.QaDeliveryNotSent('qa_document_sdk_unavailable')
            if operation=='cleanup':return {'state':'REMOVED','id':document['id'],'sha256':document['sha256']}
            return {'state':'STAGED','id':'fixture.xlsx','path':str(self.root/'fixture.xlsx'),
                    'size':len(content),'sha256':document['sha256'],'contentType':document['contentType']}
        with patch.object(m,'qa_document_sdk',side_effect=sdk),patch.object(m,'gateway_call',return_value={'channel':'whatsapp','messageId':'SYNTHETIC_MID'}) as send:
            first=self.deliver(request,payload);second=self.deliver(request,payload)
        self.assertEqual(first,{'state':'NOT_SENT','reason':'qa_document_sdk_unavailable'})
        self.assertEqual(second['state'],'ACCEPTED');self.assertEqual(send.call_count,1)
        self.assertEqual(calls,['stage','stage','cleanup'])

if __name__=='__main__':unittest.main()
