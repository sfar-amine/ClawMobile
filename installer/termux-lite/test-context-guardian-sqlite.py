#!/usr/bin/env python3
"""Real S24 metadata/schema projections plus generated defensive-volume cases."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT.parents[1] / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/c8'
CAPTURE = json.loads((FIXTURES / 'session-nodes.json').read_text())
spec = importlib.util.spec_from_file_location('guardian', ROOT / 'context-guardian-read.py')
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class GuardianSqlite(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='guardian-sqlite-')
        self.home = Path(self.temp.name)
        self.agents = self.home / '.openclaw/agents'
        self.agents.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def database(self, agent='main', rows=()):
        folder = self.agents / agent / 'agent'
        folder.mkdir(parents=True)
        database = folder / 'openclaw-agent.sqlite'
        with sqlite3.connect(database) as conn:
            # Exact queried columns from public canonical session_nodes DDL; generated minimum schema.
            conn.execute('CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)')
            conn.executemany('INSERT INTO session_nodes VALUES (?,?)', rows)
        return database

    def read(self):
        return json.loads(guardian.read_health(self.agents, now_ms=123))

    def captured_databases(self, expand=False):
        by_agent = {v['agentId']: [] for v in CAPTURE['volume']}
        for row in CAPTURE['rows']:
            by_agent[row['agentId']].append(row)
        for volume in CAPTURE['volume']:
            agent = volume['agentId']
            folder = self.agents / agent / 'agent'; folder.mkdir(parents=True)
            with sqlite3.connect(folder / 'openclaw-agent.sqlite') as conn:
                conn.execute(CAPTURE['schema']['create'])
                self.assertEqual([r[1] for r in conn.execute('PRAGMA table_info(session_nodes)')],
                                 [r['name'] for r in CAPTURE['schema']['table_info']])
                count = volume['sessionNodes'] if expand else len(by_agent[agent])
                for i in range(count):
                    row = by_agent[agent][i % len(by_agent[agent])]
                    entry = {k:v for k,v in row['entry_json_projection'].items() if k != '_absent'}
                    key = row['session_key'] + (f':volume-{i}' if expand else '')
                    conn.execute('INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,status) VALUES (?,?,?,?,?)',
                                 (key,entry['sessionId'],json.dumps(entry),row['updated_at'],row['status']))

    def test_real_s24_schema_and_closed_metadata_projection(self):
        self.captured_databases()
        rows = {r['key']:r for r in self.read()['sessions']}
        self.assertEqual(len(rows),5)
        for captured in (r for r in CAPTURE['rows'] if r['agentId']=='main'):
            entry = captured['entry_json_projection']; projected = rows[captured['session_key']]
            # Exactly the historical Guardian's arithmetic on recorded metadata.
            # This does not pretend that raw entries include CLI model/context/kind derivations.
            total = entry.get('totalTokens') or 0; context = entry.get('contextTokens',guardian.DEFAULT_CONTEXT_TOKENS)
            expected = {'key':captured['session_key'],'sessionId':entry.get('sessionId'),
                        'updatedAt':entry.get('updatedAt'),'totalTokens':total,'contextTokens':context,
                        'ratio':total/context if context else None,'kind':'cron' if ':cron:' in captured['session_key'] else 'direct','status':entry.get('status')}
            self.assertEqual({k:projected[k] for k in expected},expected)
            self.assertEqual(projected['compactionCount'],entry.get('compactionCount'))
            self.assertNotIn('contextBudgetStatus',projected)
            self.assertNotIn('model',projected)
        self.assertEqual({r['compactionCount'] for r in rows.values()}, {None,0,6})
        self.assertTrue(any(r['ratio'] and r['ratio'] >= .6 for r in rows.values()))

    def test_real_main84_scope_ignores_853_other_agent_rows(self):
        # These replicas exercise real volume/schema, not a fictitious capture of 937 entries.
        self.assertEqual(sum(v['sessionNodes'] for v in CAPTURE['volume']),937)
        self.captured_databases(expand=True)
        started = time.monotonic(); rows = self.read()['sessions']
        self.assertEqual(len(rows),84)
        self.assertLess(time.monotonic()-started,guardian.READ_SECONDS)
        self.assertEqual(len({r['key'] for r in rows}),84)
        self.assertTrue(all(r['key'].startswith('agent:main:') for r in rows))

    def test_multiple_agents_metadata_pressure_and_no_source_writes(self):
        entry = {'sessionId':'uuid_with_underscore','updatedAt':456,'totalTokens':80,'contextTokens':100,
                 'compactionCount':2,'kind':'direct','status':'running','messages':'fixture-private-transcript',
                 'access_token':'fixture-private-token','other':'fixture-private-context'}
        db = self.database(rows=[('agent:main:main',json.dumps(entry))])
        other = self.database('worker',[('agent:worker:main',json.dumps({'sessionId':'worker','updatedAt':10,'totalTokens':6}))])
        before = {str(p):digest(p) for p in (db,other)}
        doc = self.read()
        self.assertEqual(doc['version'],1); self.assertEqual(doc['checkedAtMs'],123)
        self.assertEqual(doc['sessions'][0],{'key':'agent:main:main','sessionId':'uuid_with_underscore','updatedAt':456,
          'totalTokens':80,'contextTokens':100,'compactionCount':2,'ratio':.8,'kind':'direct','status':'running'})
        self.assertEqual(len(doc['sessions']),1)
        self.assertNotIn('fixture-private',json.dumps(doc))
        self.assertEqual(before,{str(p):digest(p) for p in (db,other)})
        self.assertEqual(sorted(p.name for p in db.parent.iterdir()),['openclaw-agent.sqlite'])

    def test_main_only_no_time_window_kind_and_absent_window_fallback(self):
        self.database(rows=[
          ('agent:main:cron:fixture',json.dumps({'sessionId':'cron','updatedAt':1,'totalTokens':160000,'kind':'wrong'})),
          ('agent:main:job:fixture',json.dumps({'sessionId':'job','updatedAt':0,'totalTokens':5})),
          ('agent:main:old',json.dumps({'sessionId':'old','updatedAt':1,'totalTokens':80,'contextTokens':100})),
        ])
        # Even corrupted irrelevant stores are outside the historical scope.
        self.database('engineering-lite',rows=[('invalid-other','{')])
        rows={r['key']:r for r in self.read()['sessions']}
        self.assertEqual(len(rows),3)
        self.assertEqual(rows['agent:main:cron:fixture']['kind'],'cron')
        self.assertEqual(rows['agent:main:job:fixture']['kind'],'direct')
        self.assertEqual(rows['agent:main:cron:fixture']['contextTokens'],200000)
        self.assertEqual(rows['agent:main:cron:fixture']['ratio'],.8)
        self.assertEqual(rows['agent:main:old']['contextTokens'],100)
        self.assertEqual(rows['agent:main:old']['ratio'],.8)

    def test_read_only_wal_sees_committed_owner_update(self):
        db = self.database(rows=[('agent:main:main',json.dumps({'sessionId':'first','totalTokens':1}))])
        writer = sqlite3.connect(db)
        try:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('UPDATE session_nodes SET entry_json=?', (json.dumps({'sessionId':'first','totalTokens':9}),))
            writer.commit()
            before = {p.name:digest(p) for p in db.parent.iterdir() if not p.name.endswith('-shm')}
            names = sorted(p.name for p in db.parent.iterdir())
            self.assertEqual(self.read()['sessions'][0]['totalTokens'],9)
            self.assertEqual(before,{p.name:digest(p) for p in db.parent.iterdir() if not p.name.endswith('-shm')})
            self.assertEqual(names, sorted(p.name for p in db.parent.iterdir()))
            # Native read-only SQLite reader marks can update existing SHM coordination; never DB/WAL.
        finally:
            writer.close()

    def test_invalid_source_preserves_existing_private_health_and_never_starts_node(self):
        self.database(rows=[('agent:main:main','{')])
        state = self.home / '.openclaw/context-sync/state'; state.mkdir(parents=True)
        health = state / 'health.json'; old = '{"version":1,"sessions":[]}'
        health.write_text(old)
        executables = self.home / 'bin'; executables.mkdir()
        for executable in ('node','openclaw'):
            fake = executables / executable
            fake.write_text('#!/bin/sh\ntouch "$HOME/forbidden-cli-start"\nexit 1\n'); fake.chmod(0o755)
        env = {**os.environ,'HOME':str(self.home),'CLAW_RUNTIME_ROOT':str(ROOT),'PATH':str(executables)+':'+os.environ['PATH']}
        result = subprocess.run(['bash',str(ROOT/'context-guardian.sh')],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0)
        self.assertEqual(health.read_text(),old)
        self.assertFalse((self.home/'forbidden-cli-start').exists())
        self.assertFalse(list(state.glob('health.json.tmp.*')))
        self.assertIn('event=session_read state=unavailable', (state.parent/'context-guardian.log').read_text())
        self.assertNotIn('session_key',result.stderr)

    def test_real_script_writes_same_owner_artifact_with_pressure_counts(self):
        self.database(rows=[('agent:main:main',json.dumps({'sessionId':'id','totalTokens':80,'contextTokens':100}))])
        env={**os.environ,'HOME':str(self.home),'CLAW_RUNTIME_ROOT':str(ROOT)}
        result=subprocess.run(['bash',str(ROOT/'context-guardian.sh')],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0)
        output=self.home/'.openclaw/context-sync/state/health.json'
        self.assertEqual(json.loads(output.read_text())['sessions'][0]['ratio'],.8)
        self.assertEqual(output.stat().st_mode&0o777,0o600)
        self.assertIn('soft_ge_60=1 hard_ge_80=1',(output.parent.parent/'context-guardian.log').read_text())

    def test_200001_generated_rows_stop_at_bound_instead_of_fresh_partial(self):
        self.database(rows=((f'agent:main:fixture-{i}',json.dumps({'sessionId':f'fixture-{i}','totalTokens':1})) for i in range(200001)))
        started=time.monotonic()
        with self.assertRaisesRegex(guardian.Unavailable,'session_row_limit'): self.read()
        self.assertLess(time.monotonic()-started,guardian.READ_SECONDS)

    def test_missing_database_no_creation_bad_schema_and_symlink_refused(self):
        with self.assertRaises(guardian.Unavailable): self.read()
        self.assertEqual(list(self.agents.iterdir()),[])
        db=self.database();db.unlink()
        db.symlink_to(self.home/'absent.sqlite')
        with self.assertRaises(guardian.Unavailable): self.read()
        self.assertFalse((self.home/'absent.sqlite').exists())
        db.unlink();db.write_bytes(b'not a SQLite source')
        with self.assertRaises(guardian.Unavailable): self.read()

    def test_large_native_entry_rejected_before_python_materialization(self):
        self.database(rows=[('agent:main:main',json.dumps({'sessionId':'id','privateTranscript':'x'*(10<<20)}))])
        with self.assertRaises(guardian.Unavailable): self.read()

    def test_deadline_and_nonfinite_numbers_are_bounded(self):
        db=self.database(rows=[('agent:main:main',json.dumps({'sessionId':'id','totalTokens':1e308,'contextTokens':1e-308}))])
        self.assertIsNone(self.read()['sessions'][0]['ratio'])
        old=guardian.READ_SECONDS
        try:
            guardian.READ_SECONDS=0
            with self.assertRaises(guardian.Unavailable): self.read()
        finally:
            guardian.READ_SECONDS=old


if __name__ == '__main__':
    unittest.main()
