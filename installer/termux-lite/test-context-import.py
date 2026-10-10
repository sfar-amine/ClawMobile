import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0,str(Path(__file__).parent))
from context_import import preview

class MemoryImport(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name)
        spec=importlib.util.spec_from_file_location('context_store',Path(__file__).with_name('context-store.py'))
        self.owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.owner)
        self.owner.D=root/'context';self.owner.DB=self.owner.D/'memory.db'
        with self.owner.connect() as c:self.owner.migrate(c)
        self.export=[{'mapping':{'one':{'message':{'author':{'role':'user'},'content':{'content_type':'text','parts':['Prefer short answers']},'create_time':1791633600}},'two':{'message':{'author':{'role':'user'},'content':{'content_type':'text','parts':['Use local notes']}}},'assistant':{'message':{'author':{'role':'assistant'},'content':{'content_type':'text','parts':['Do not automatically learn my answer']}}}}}]
        self.plan=preview('chatgpt',self.export)
        self.body=dict(source='chatgpt',export=self.export,previewHash=self.plan['previewHash'],selectedIds=[r['id'] for r in self.plan['items']],operationId='import-one')

    def count(self):
        with sqlite3.connect(self.owner.DB) as c:return c.execute('SELECT count(*) FROM events').fetchone()[0]

    def test_preview_has_no_writes_and_filters_sources(self):
        before=self.owner.DB.read_bytes()
        result=preview('chatgpt',self.export)
        self.assertEqual(len(result['items']),2);self.assertFalse(result['writes']);self.assertEqual(self.owner.DB.read_bytes(),before)
        claude=preview('claude',[{'chat_messages':[{'sender':'human','text':'Use concise wording','created_at':'2026-10-10T10:00:00Z'},{'sender':'assistant','text':'Not an owner fact'},{'sender':'human','text':'token Bearer private'},{'sender':'human','text':'paiement Maxit 10 TND'}]}])
        self.assertEqual(len(claude['items']),1);self.assertEqual(claude['filteredCount'],2)
        self.assertNotIn('private',json.dumps(claude));self.assertEqual(self.count(),0)

    def test_import_atomic_receipt_replay_and_forget(self):
        first=self.owner.control_import(self.body)
        self.assertEqual(first['state'],'imported');self.assertEqual(first['importedCount'],2)
        self.assertEqual(self.count(),3)
        self.assertEqual(self.owner.control_import(self.body),first);self.assertEqual(self.count(),3)
        changed=dict(self.body,selectedIds=self.body['selectedIds'][:1]);self.assertEqual(self.owner.control_import(changed)['state'],'conflict');self.assertEqual(self.count(),3)
        with self.owner.control_read() as c:
            from context_memory import control_items
            items=control_items(c,kind='import')['items'];self.assertEqual(len(items),2)
            self.assertTrue(all(item['source']=='chatgpt' for item in items))
        forgotten=self.owner.control_command(['control-forget',items[0]['id'],'forget-one']);self.assertEqual(forgotten['state'],'forgotten')
        self.assertEqual(self.owner.control_command(['control-forget',items[0]['id'],'forget-one']),forgotten)
        self.assertEqual(self.owner.control_command(['control-forget-check',items[1]['id'],'forget-one'])['state'],'conflict')
        self.assertEqual(self.count(),4)

    def test_preview_changed_and_unknown_selection_write_nothing(self):
        for changed in [dict(self.body,previewHash='f'*64),dict(self.body,selectedIds=['e'*64]),dict(self.body,selectedIds=[]),dict(self.body,selectedIds=[self.body['selectedIds'][0]]*2)]:
            with self.assertRaises(ValueError):self.owner.control_import(changed)
        self.assertEqual(self.count(),0)

    def test_failed_second_insert_rolls_back_whole_batch(self):
        # Force failure only after the first selected event was inserted.
        with sqlite3.connect(self.owner.DB) as c:
            c.execute("CREATE TRIGGER reject_second BEFORE INSERT ON events WHEN (SELECT count(*) FROM events)>0 BEGIN SELECT RAISE(ABORT,'fixture-reject'); END")
        with self.assertRaises(sqlite3.Error):self.owner.control_import(self.body)
        self.assertEqual(self.count(),0)
        self.assertEqual(self.owner.control_import(self.body,check=True)['state'],'not_found')

    def test_archive_failure_after_commit_preserves_receipt_and_replay(self):
        with patch.object(self.owner.os,"open",side_effect=OSError("fixture archive unavailable")):
            result=self.owner.control_import(self.body)
        self.assertEqual(result["state"],"imported");self.assertEqual(self.count(),3)
        self.assertEqual(self.owner.control_import(self.body,check=True),result)
        self.assertEqual(self.owner.control_import(self.body),result);self.assertEqual(self.count(),3)

    def test_sensitive_code_aws_and_jwt_filtered(self):
        result=preview("claude",[{"chat_messages":[{"sender":"human","text":text} for text in ["Code 123456", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "Keep a local notebook"]]}])
        self.assertEqual(len(result["items"]),1);self.assertEqual(result["filteredCount"],3)

    def test_bounded_export_and_import_selection(self):
        with self.assertRaises(ValueError):preview('other',[])
        with self.assertRaises(ValueError):preview('claude',[{'chat_messages':[]}]*51)
        with self.assertRaises(ValueError):preview('claude',[{'chat_messages':[{'sender':'human','text':'a'*20000}]*100}])

if __name__=='__main__':unittest.main()
