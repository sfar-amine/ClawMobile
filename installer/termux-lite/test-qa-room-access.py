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

    def test_changed_grant_changes_revision_even_in_same_room(self):
        previous=self.read()['scope']['grant_revision']
        self.metadata['qaApps'][0]['allow_writes']=True;self.persist()
        self.assertNotEqual(previous,self.read()['scope']['grant_revision'])

    def test_new_app_and_write_raise_in_existing_room_require_biometrics(self):
        for apps in ([{**APP,'allow_writes':True}], [APP,{**APP,'app_id':'second','package':'test.claw.qa.other'}]):
            body={'operationId':'qa-grant-fixture','contactId':self.identity,'rooms':['conversation','qa'],'qaApps':apps}
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

if __name__=='__main__':unittest.main()
