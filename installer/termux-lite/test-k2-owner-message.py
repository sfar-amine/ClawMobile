"""K2 isolation: real PR184 source shape, temp R17 database, zero real sends."""
import importlib.util,json,sqlite3,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('r17_harness',Path(__file__).with_name('test-whatsapp-allowlist.py'));h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
m=h.m
class K2Tests(unittest.TestCase):
    setUp=h.AllowlistTests.setUp
    tearDown=h.AllowlistTests.tearDown
    save=h.AllowlistTests.save
    gateway=h.AllowlistTests.gateway
    body=h.AllowlistTests.body
    confirmed=h.AllowlistTests.confirmed
    add=h.AllowlistTests.add
    def setUp(self):
        h.AllowlistTests.setUp(self);self.sent=[]
        self.service.owner_sender=lambda text,key:self.sent.append((text,key)) or 'accepted'
    def receipt(self,body):return self.service.read_operation(body['operationId'],body['requestHash'])['receipt']
    def test_real_source_and_no_parallel_store(self):
        source=Path(__file__).parents[2]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/k2/access-change-owner-delivery-pr184.json'
        cap=json.loads(source.read_text());owners=cap['codeOwners'];self.assertIn('send_receipts',owners['receipt']['store']);self.assertIn('whatsapp-owner-send.sh',owners['existingOwnerDeliveryPrimitive']['script']);self.assertEqual(cap['s24']['sendReceipts']['r17Rows'],0)
        self.add(durationDays=1)
        with sqlite3.connect(m.DB) as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM send_receipts').fetchone()[0],1)
            self.assertEqual({r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")},{'people','phones','emails','interactions','send_receipts','meta'})
    def test_grant_extend_remove_one_notice_each_and_no_contact_send(self):
        result,grant=self.add(durationDays=1);self.assertEqual(result['receipt']['ownerMessage']['state'],'pending');self.assertEqual(self.sent,[])
        self.service.call('sweep',{});self.assertEqual(self.receipt(grant)['ownerMessage']['state'],'accepted')
        self.assertEqual(self.service.call('add',grant)['receipt']['ownerMessage']['state'],'accepted');self.service.call('sweep',{});self.assertEqual(len(self.sent),1)
        extend=self.body('expiry',contactId=m.contact_id(h.NEW),durationDays=3);self.confirmed(extend,'extend',duration=3);self.service.call('expiry',extend);self.service.call('sweep',{})
        remove=self.body('remove',contactId=m.contact_id(h.NEW));self.confirmed(remove,'remove');self.service.call('remove',remove);self.service.call('sweep',{})
        self.assertEqual([x[0] for x in self.sent],['Accès WhatsApp '+label+' (référence '+m.contact_id(h.NEW)+').' for label in ('accordé','prolongé','retiré')]);self.assertEqual(len(set(x[1] for x in self.sent)),3);self.sender.assert_not_called()
        self.assertNotIn(h.NEW,json.dumps(self.sent));self.assertNotIn('Private',json.dumps(self.sent))
    def test_expiration_sweep_stable_operation_and_restart_no_reminder(self):
        _,grant=self.add(durationDays=1);self.service.call('sweep',{});self.now+=86401
        out=self.service.call('sweep',{});self.assertTrue(out['success']);self.assertEqual(self.sent[-1][0],'Accès WhatsApp expiré (référence '+m.contact_id(h.NEW)+').' )
        with sqlite3.connect(m.DB) as c:rows=c.execute("SELECT message_id FROM send_receipts WHERE idempotency_key LIKE 'r17:%'").fetchall()
        expiry=next(json.loads(row[0]) for row in rows if json.loads(row[0])['receipt']['action']=='expired');op=expiry['receipt']['operationId'];self.assertTrue(op.startswith('expire:'));self.assertEqual(expiry['receipt']['ownerMessage']['state'],'accepted')
        restarted=m.Contacts(m._ExistingPeopleOwner(),clock=lambda:self.now,state_dir=self.root,owner_sender=self.service.owner_sender);restarted.call('sweep',{});self.assertEqual(len(self.sent),2);self.assertEqual(restarted.read_operation(op)['receipt']['ownerMessage']['state'],'accepted')
    def test_permanent_grant_remove_and_no_op_or_note_without_extra_notice(self):
        _,grant=self.add();self.service.call('sweep',{});self.assertEqual(len(self.sent),1)
        no_op=self.body('expiry',contactId=m.contact_id(h.NEW),durationDays=None);self.service.call('expiry',no_op);self.service.call('sweep',{});self.assertEqual(len(self.sent),1)
        note=self.body('note',contactId=m.contact_id(h.NEW),text='Private note');self.service.call('note',note);self.service.call('sweep',{});self.assertEqual(len(self.sent),1)
        remove=self.body('remove',contactId=m.contact_id(h.NEW));self.confirmed(remove,'remove');self.service.call('remove',remove);self.service.call('sweep',{});self.assertEqual(len(self.sent),2)
        self.assertIn('accordé',self.sent[0][0]);self.assertIn('retiré',self.sent[1][0])
    def test_extension_to_permanent_is_a_change(self):
        self.add(durationDays=1);self.service.call('sweep',{})
        extend=self.body('expiry',contactId=m.contact_id(h.NEW),durationDays=None);self.confirmed(extend,'extend',duration=None);self.service.call('expiry',extend);self.service.call('sweep',{});self.assertEqual(len(self.sent),2);self.assertIn('prolongé',self.sent[1][0])
    def test_uncertainty_never_resends_even_after_restart(self):
        _,grant=self.add(durationDays=1)
        def uncertain(text,key):self.sent.append((text,key));raise TimeoutError('never leak provider text')
        self.service.owner_sender=uncertain;self.service.call('sweep',{});self.assertEqual(self.receipt(grant)['ownerMessage']['state'],'indeterminate')
        self.service.call('sweep',{});restarted=m.Contacts(m._ExistingPeopleOwner(),clock=lambda:self.now,state_dir=self.root,owner_sender=self.service.owner_sender);restarted.call('sweep',{});self.assertEqual(len(self.sent),1);self.assertNotIn('never leak',json.dumps(self.receipt(grant)))
    def test_claim_is_atomic_with_two_sweeps(self):
        _,grant=self.add(durationDays=1);entered=threading.Event();release=threading.Event()
        def blocked(text,key):self.sent.append((text,key));entered.set();release.wait(2);return 'accepted'
        self.service.owner_sender=blocked;second=m.Contacts(m._ExistingPeopleOwner(),clock=lambda:self.now,state_dir=self.root,owner_sender=blocked)
        first=threading.Thread(target=self.service.deliver_owner_change);first.start();self.assertTrue(entered.wait(1));self.assertEqual(second.deliver_owner_change()['state'],'idle');release.set();first.join(2);self.assertFalse(first.is_alive());self.assertEqual(len(self.sent),1)
    def test_one_delivery_per_pass_no_before_expiry_reminder(self):
        self.add(durationDays=1)
        extend=self.body('expiry',contactId=m.contact_id(h.NEW),durationDays=3);self.confirmed(extend,'extend',duration=3);self.service.call('expiry',extend)
        self.now+=3600;self.service.call('sweep',{});self.assertEqual(len(self.sent),1)
        self.service.call('sweep',{});self.assertEqual(len(self.sent),2)
        self.service.call('sweep',{});self.assertEqual(len(self.sent),2)
    def test_pending_atomic_receipt_does_not_alter_operation_hash_or_time(self):
        _,grant=self.add(durationDays=1)
        with sqlite3.connect(m.DB) as c:before=c.execute('SELECT message_sha256,state,created_at,updated_at FROM send_receipts').fetchone()
        self.now+=60;self.service.call('sweep',{})
        with sqlite3.connect(m.DB) as c:after=c.execute('SELECT message_sha256,state,created_at,updated_at FROM send_receipts').fetchone()
        self.assertEqual(before,after);self.assertEqual(self.receipt(grant)['ownerMessage']['state'],'accepted')
    def test_crash_after_effect_intent_survives_replay_without_second_mutation(self):
        class SimulatedKill(BaseException):pass
        with patch.object(self.service,'finish',side_effect=SimulatedKill):
            with self.assertRaises(SimulatedKill):self.add(durationDays=1)
        self.assertIn(h.NEW,self.cfg['channels']['whatsapp']['allowFrom'])
        receipt=self.service.read_operation('add-operation');self.assertFalse(receipt['success']);self.assertEqual(receipt['receipt']['ownerMessage'],{'state':'awaiting_change','change':'added'})
        before=len(self.calls);restarted=m.Contacts(m._ExistingPeopleOwner(),clock=lambda:self.now,state_dir=self.root,owner_sender=self.service.owner_sender)
        replay=self.body('add',e164=h.NEW,contactId=m.contact_id(h.NEW),scope='standard',scopeText=None,durationDays=1,notify=False)
        self.confirmed(replay,'add',duration=1,prepare=False)
        self.assertEqual(restarted.call('add',replay)['receipt']['ownerMessage']['state'],'awaiting_change');self.assertEqual(len(self.calls),before)
        self.assertEqual(restarted.deliver_owner_change()['state'],'idle');self.assertEqual(self.sent,[])
    def test_fifty_thousand_historical_receipts_one_pending_without_new_rows(self):
        _,grant=self.add(durationDays=1)
        value=json.dumps({'success':True,'receipt':{'action':'added','ownerMessage':{'state':'accepted'}}})
        with sqlite3.connect(m.DB) as c:
            c.executemany('INSERT INTO send_receipts VALUES(?,?,?,?,?,?,?)',(('r17:'+str(i),'wa-history','hash','added',value,0,0) for i in range(50000)))
        self.assertEqual(self.service.deliver_owner_change()['state'],'accepted');self.assertEqual(len(self.sent),1)
        with sqlite3.connect(m.DB) as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM send_receipts').fetchone()[0],50001)
    def test_failed_mutation_has_no_owner_notice(self):
        def uncertain(method,params=None,timeout_ms=7000):
            if method=='config.patch':raise TimeoutError('hidden payload')
            return self.gateway(method,params,timeout_ms)
        self.gw.stop();self.gw=patch.object(m,'gateway_call',side_effect=uncertain);self.gw.start()
        result,grant=self.add(durationDays=1);self.assertFalse(result['success']);self.assertEqual(result['receipt']['ownerMessage']['state'],'awaiting_change');self.assertEqual(self.service.deliver_owner_change()['state'],'idle');self.assertEqual(self.sent,[])
    def test_existing_owner_primitive_boundary_acceptance_is_not_delivery(self):
        with patch.object(m.subprocess,'run') as run:
            run.return_value.returncode=0;self.assertEqual(self.service.send_owner_message('fixed text','k2:123'),'accepted');args=run.call_args.args[0];self.assertEqual(Path(args[1]).name,'whatsapp-owner-send.sh');self.assertEqual(run.call_args.kwargs['timeout'],17)
            run.return_value.returncode=66;self.assertEqual(self.service.send_owner_message('fixed text','k2:123'),'failed_before_effect')
            run.return_value.returncode=67;self.assertEqual(self.service.send_owner_message('fixed text','k2:123'),'indeterminate')
if __name__=='__main__':unittest.main()
