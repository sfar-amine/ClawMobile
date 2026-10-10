#!/usr/bin/env python3
"""R10: real ingress/SQLite origin without date, text or cursor inference."""
import hashlib, importlib.util, json, os, shutil, sqlite3, subprocess, tempfile, unittest
from pathlib import Path

SOURCE=Path(__file__).resolve().parent
class OriginTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='r10-origin-');self.home=Path(self.tmp.name);self.root=self.home/'context';self.bin=self.home/'bin';self.bin.mkdir()
        for name in ('context-event.sh','context-store.py','context_memory.py','context_import.py'):
            p=self.bin/name;p.write_text((SOURCE/name).read_text().replace('#!/data/data/com.termux/files/usr/bin/bash','#!/usr/bin/env bash',1).replace('#!/data/data/com.termux/files/usr/bin/python3','#!/usr/bin/env python3',1));p.chmod(0o700)
        (self.bin/'context-compact.sh').write_text('#!/bin/sh\nexit 0\n');(self.bin/'context-compact.sh').chmod(0o700)
        self.env=dict(os.environ,SAMANTHA_CONTEXT_ROOT=str(self.root))
    def tearDown(self):self.tmp.cleanup()
    def event(self,*args,ok=True):
        p=subprocess.run(['bash',str(self.bin/'context-event.sh'),*args],env=self.env,text=True,capture_output=True)
        if ok:self.assertEqual(p.returncode,0,p.stderr)
        else:self.assertNotEqual(p.returncode,0)
        return p.stdout.strip()
    def rows(self):
        with sqlite3.connect(self.root/'memory.db') as c:return c.execute('SELECT id,revision,session_id,supersedes FROM events ORDER BY revision').fetchall()
    def ingest(self,obj,ok=True):
        p=self.home/'candidate.json';p.write_text(json.dumps(obj));out=subprocess.run(['python3',str(self.bin/'context-store.py'),'ingest-file',str(p)],env=self.env,text=True,capture_output=True)
        self.assertEqual(out.returncode==0,ok,out.stderr);return out
    def test_legacy_hash_null_and_migration(self):
        self.root.mkdir();legacy=hashlib.sha256(b'chat\0open_thread\0\0Same request').hexdigest()
        with sqlite3.connect(self.root/'memory.db') as c:
            c.execute('CREATE TABLE events(id TEXT PRIMARY KEY,surface TEXT,kind TEXT,text TEXT,created_at TEXT,ingested_at TEXT,supersedes TEXT,revision INTEGER)');c.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)',(legacy,'chat','open_thread','Same request','2026-10-10T00:00:00Z','2026-10-10T00:00:00Z',None,41))
        self.assertEqual(self.event('chat','open_thread','Same request'),legacy)
        self.assertEqual(self.rows(),[(legacy,41,None,None)])
        other=self.event('voice','open_thread','No conversation');self.assertEqual(self.rows()[-1],(other,42,None,None))
    def test_same_text_distinct_origins_exact_replay(self):
        a=self.event('chat','open_thread','--session','alpha_1','Same request');b=self.event('chat','open_thread','--session','beta-2','Same request')
        self.assertNotEqual(a,b);self.assertEqual(a,self.event('chat','open_thread','--session','alpha_1','Same request'));self.assertEqual([(r[1],r[2]) for r in self.rows()],[(1,'alpha_1'),(2,'beta-2')])
        self.assertEqual(json.loads((self.root/'processed'/f'{a}.json').read_text())['sessionId'],'alpha_1')
    def test_invalid_flags_write_nothing(self):
        for flags in [('chat','open_thread','--session','agent:main:x','x'),('chat','open_thread','--session','x'*81,'x'),('chat','open_thread','--session','alpha\nbeta','x'),('chat','decision','--session','alpha','x'),('chat','open_thread','--session','a','--session','b','x'),('chat','open_thread','--other','x')]:self.event(*flags,ok=False)
        self.assertFalse(self.root.exists())
    def test_conflict_and_bad_json_leave_events_unchanged(self):
        a=self.event('work','open_thread','--session','alpha','Same request');before=self.rows();obj=json.loads((self.root/'processed'/f'{a}.json').read_text());obj['sessionId']='beta'
        self.assertIn('event_session_conflict',self.ingest(obj,ok=False).stderr);self.assertEqual(self.rows(),before)
        obj['sessionId']='agent:main:x';self.assertIn('invalid_companion_session',self.ingest(obj,ok=False).stderr);self.assertEqual(self.rows(),before)
    def test_supersedes_preserves_root_and_refuses_wrong_origin(self):
        a=self.event('chat','open_thread','--session','alpha','Same request');b=self.event('chat','open_thread','--supersedes',a,'Updated request')
        self.assertEqual(self.rows()[-1],(b,2,None,a));before=self.rows()
        self.event('chat','open_thread','--session','beta','--supersedes',b,'Wrong request',ok=False);self.assertEqual(self.rows(),before)
        end=self.event('chat','completed_action','--supersedes',b,'Closed');self.assertEqual(self.rows()[-1],(end,3,None,b));self.assertEqual(self.rows()[0][2],'alpha')
    def test_v1_json_and_literal_marker_do_not_infer_origin(self):
        self.root.mkdir();obj={'version':1,'id':'d'*64,'surface':'chat','kind':'open_thread','text':'[companion-session:fake] user text','createdAt':'2026-10-10T00:00:00Z'};self.ingest(obj);self.assertEqual(self.rows()[0][2],None)

if __name__=='__main__':unittest.main()
