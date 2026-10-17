#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('context_store',ROOT/'context-store.py')
store=importlib.util.module_from_spec(spec);spec.loader.exec_module(store)


class M6RetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        store.D=self.root;store.DB=self.root/'memory.db'
        self.connection=store.connect();store.migrate(self.connection)

    def tearDown(self):
        self.connection.close();self.tmp.cleanup()

    def event(self,revision=1):
        return {'id':f'{revision:064x}','surface':'chat','kind':'decision',
                'text':f'M6 durable event {revision}','createdAt':f'2026-10-{revision:02d}T10:00:00+00:00'}

    def pending(self,event,directory='pending'):
        folder=self.root/directory;folder.mkdir(exist_ok=True)
        path=folder/(event['id']+'.json');path.write_text(json.dumps(event));return path

    def test_transient_copy_deleted_only_after_db_and_fsynced_history(self):
        event=self.event();path=self.pending(event)
        result=store.ingest_file(self.connection,path)
        self.assertTrue(result['inserted']);self.assertFalse(path.exists())
        row=self.connection.execute('select revision,text from events where id=?',(event['id'],)).fetchone()
        self.assertEqual(row,(1,event['text']))
        history=list((self.root/'history').glob('*.jsonl'))
        self.assertEqual(len(history),1);self.assertIn(event['id'],history[0].read_text())
        self.assertFalse((self.root/'processed'/path.name).exists())

    def test_archive_failure_retains_pending_for_recovery(self):
        event=self.event();path=self.pending(event)
        original=store._archive
        try:
            store._archive=lambda *_: (_ for _ in ()).throw(OSError('disk full'))
            with self.assertRaises(OSError):store.ingest_file(self.connection,path)
        finally:store._archive=original
        self.assertTrue(path.exists())
        self.assertIsNotNone(self.connection.execute('select 1 from events where id=?',(event['id'],)).fetchone())

    def test_legacy_processed_removed_after_existing_history_matches(self):
        event=self.event();pending=self.pending(event)
        store.ingest_file(self.connection,pending)
        legacy=self.pending(event,'processed')
        result=store.ingest_file(self.connection,legacy)
        self.assertFalse(result['inserted']);self.assertFalse(legacy.exists())

    def test_history_rebuild_preserves_revisions_without_processed(self):
        for revision in range(1,4):store.ingest_file(self.connection,self.pending(self.event(revision)))
        self.connection.close();(self.root/'memory.db').unlink()
        self.connection=store.connect();store.migrate(self.connection)
        for archive in sorted((self.root/'history').glob('*.jsonl')):
            for line in archive.read_text().splitlines():
                store.ingest_event(self.connection,json.loads(line),replay_history=True)
        rows=self.connection.execute('select revision,text from events order by revision').fetchall()
        self.assertEqual(rows,[(i,f'M6 durable event {i}') for i in range(1,4)])

    def test_existing_cursor_owner_keeps_hot_context_attestations(self):
        store.ingest_file(self.connection,self.pending(self.event()))
        sha='a'*64
        state={'knownContracts':{'AGENTS.md':sha},
               'globalBaseline':{'sha256':sha,'semantic_sha256':sha,'foundation_sha256':sha,'revision':1}}
        row=store.cursor(self.connection,'mcp-codex','codex',1,state)
        self.assertEqual(row['lastSeenRevision'],1)
        self.assertEqual(row['knownContracts'],{'AGENTS.md':sha})
        self.assertEqual(store.cursor(self.connection,'mcp-codex')['globalBaseline']['revision'],1)


if __name__=='__main__':unittest.main()
