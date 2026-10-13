#!/usr/bin/env python3
import importlib.util,json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

MODULE=Path(__file__).with_name('people-trusted.py')
spec=importlib.util.spec_from_file_location('people_trusted_contact_memory',MODULE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NUMBER='+21620000001'

class ContactMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.old=(m.ROOT,m.DB,m.WORKSPACE,m.CONTACTS,m.CONFIG,m.SESSION_DB)
        m.ROOT=self.root/'people';m.DB=m.ROOT/'directory.db';m.WORKSPACE=self.root/'workspace'
        m.CONTACTS=m.WORKSPACE/'memory/whatsapp/contacts';m.CONTACTS.mkdir(parents=True)
        m.CONFIG=self.root/'openclaw.json';m.SESSION_DB=self.root/'main.sqlite'
        self.state=self.root/'state';self.agent='contacts';self.db=self.state/'agents'/self.agent/'agent/openclaw-agent.sqlite'
        self.db.parent.mkdir(parents=True)
        with sqlite3.connect(self.db) as c:
            c.execute('CREATE TABLE session_windows(session_id TEXT PRIMARY KEY,session_key TEXT,channel TEXT,chat_type TEXT)')
            c.execute('CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,created_at INTEGER,event_zstd BLOB,PRIMARY KEY(session_id,seq))')
            c.execute('INSERT INTO session_windows VALUES(?,?,?,?)',('s1','agent:contacts:whatsapp:direct:'+NUMBER,'whatsapp','direct'))
        self.cfg={'commands':{'ownerAllowFrom':['whatsapp:+21653792744']},'channels':{'whatsapp':{'allowFrom':[NUMBER],
                  'direct':{NUMBER:{'systemPrompt':'Scope existant','other':'kept'},'*':{'systemPrompt':'base'}}}}}
        m.CONFIG.write_text(json.dumps(self.cfg))
        self.service=m.Contacts(m._ExistingPeopleOwner(),clock=lambda:1791849600,state_dir=self.state)
        metadata={'state':'active','scope':'standard','scopeText':None,'expiresAt':None,'addedAt':'2026-10-12T00:00:00Z','suspendedScope':None,'personId':None,'rooms':['conversation']}
        self.service.write_context(NUMBER,metadata,note='# Contact\n- Last compacted: not yet\n')

    def tearDown(self):
        m.ROOT,m.DB,m.WORKSPACE,m.CONTACTS,m.CONFIG,m.SESSION_DB=self.old;self.temp.cleanup()

    def message(self,seq,role,content,channel='whatsapp'):
        event={'type':'message','message':{'role':role,'content':content,'__openclaw':{'transport':{'channel':channel}}}}
        with sqlite3.connect(self.db) as c:c.execute('INSERT INTO transcript_events VALUES(?,?,?,?,NULL)',('s1',seq,json.dumps(event),seq))

    def gateway(self,method,params=None,timeout_ms=7000):
        if method=='config.get':return {'hash':'h1','config':json.loads(json.dumps(self.cfg))}
        self.assertEqual(method,'config.patch');patch_value=json.loads(params['raw'])['channels']['whatsapp']['direct'][NUMBER]
        self.cfg['channels']['whatsapp']['direct'][NUMBER]=patch_value
        return {'config':json.loads(json.dumps(self.cfg)),'changedPaths':['channels.whatsapp.direct.'+NUMBER]}

    def test_compacts_contact_delta_preserves_scope_and_advances_cursor(self):
        self.message(1,'user','Je préfère les réponses courtes sur le projet Atlas.')
        self.message(2,'user','Je vais envoyer le dossier demain. Où en est la réunion ?')
        self.message(3,'assistant','Réponse complète qui ne doit jamais être copiée.')
        self.message(4,'user','mon mot de passe est SECRET-RAW')
        facts=[]
        with patch.object(m,'gateway_call',side_effect=self.gateway),patch.object(self.service,'remember_contact_fact',side_effect=lambda identity,fact:facts.append((identity,fact))):
            result=self.service.compact_contacts()
        self.assertTrue(result['success']);self.assertEqual(result['events'],4);self.assertEqual(result['facts'],2)
        prompt=self.cfg['channels']['whatsapp']['direct'][NUMBER]['systemPrompt']
        self.assertIn('Scope existant',prompt);self.assertIn('Sujets ouverts : projet; agenda',prompt)
        self.assertIn('Préfère : les réponses courtes sur le projet Atlas',prompt)
        self.assertNotIn('SECRET-RAW',prompt);self.assertEqual(self.cfg['channels']['whatsapp']['direct'][NUMBER]['other'],'kept')
        metadata=self.service.metadata(NUMBER);self.assertEqual(metadata['contactMemory']['cursors']['contacts'],4)
        note=self.service.context(NUMBER);self.assertNotIn('Réponse complète',note);self.assertNotIn('SECRET-RAW',note);self.assertNotIn('not yet',note)
        self.assertTrue(all(source==m.contact_id(NUMBER) for source,_ in facts))
        with patch.object(m,'gateway_call') as gateway,patch.object(self.service,'remember_contact_fact'):
            replay=self.service.compact_contacts()
        self.assertEqual(replay['events'],0);gateway.assert_not_called()

    def test_gateway_failure_does_not_commit_cursor(self):
        self.message(1,'user','Je préfère le français.')
        before=self.service.context(NUMBER)
        with patch.object(m,'gateway_call',side_effect=RuntimeError('down')),patch.object(self.service,'remember_contact_fact'):
            result=self.service.compact_contacts()
        self.assertFalse(result['success']);self.assertEqual(result['issues'][0]['reason'],'contact_memory_unavailable')
        self.assertEqual(self.service.context(NUMBER),before);self.assertNotIn('contactMemory',self.service.metadata(NUMBER))

    def test_only_contact_agent_and_matching_peer_are_read(self):
        foreign=self.state/'agents/main/agent/openclaw-agent.sqlite';foreign.parent.mkdir(parents=True);foreign.touch()
        self.message(1,'user','I prefer English.')
        with sqlite3.connect(self.db) as c:
            c.execute('INSERT INTO session_windows VALUES(?,?,?,?)',('s2','agent:contacts:whatsapp:direct:+21699999999','whatsapp','direct'))
            c.execute('INSERT INTO transcript_events VALUES(?,?,?,?,NULL)',('s2',1,json.dumps({'type':'message','message':{'role':'user','content':'I prefer FOREIGN','__openclaw':{'transport':{'channel':'whatsapp'}}}}),1))
        databases=self.service.contact_agent_databases();self.assertEqual([(a,p.name) for a,p in databases],[('contacts','openclaw-agent.sqlite')])
        rows,cursor,more=self.service.transcript_delta('contacts',self.db,NUMBER,0)
        self.assertEqual(len(rows),1);self.assertEqual(cursor,1);self.assertFalse(more)

    def test_secret_and_size_guards(self):
        summary,facts=m.summarize_contact_messages([{'role':'user','content':'I prefer api_key ABCDEF'},{'role':'user','content':'I will call +216 12 345 678'}])
        self.assertEqual(facts,[]);self.assertEqual(summary['preferences'],[]);self.assertEqual(summary['commitments'],[])
        with self.assertRaises(m.Refused):m.replace_contact_memory_block('x'*4090,m.contact_memory_block(summary))

if __name__=='__main__':unittest.main(verbosity=2)
