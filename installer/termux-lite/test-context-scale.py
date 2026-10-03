#!/usr/bin/env python3
"""Independent long-history, loss-of-context, rebuild and safety regressions."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from context_memory import build_view, search
spec = importlib.util.spec_from_file_location('store_test', HERE / 'context-store.py')
store = importlib.util.module_from_spec(spec); spec.loader.exec_module(store)


def add(c, rev, kind, text, supersedes=None, surface='chat'):
    eid = hashlib.sha256(f'{rev}:{text}'.encode()).hexdigest()
    c.execute('INSERT INTO events(id,revision,surface,kind,text,created_at,ingested_at,supersedes) VALUES(?,?,?,?,?,?,?,?)',
              (eid, rev, surface, kind, text, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', supersedes))
    return eid


class ScaleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.db = self.root / 'memory.db'; self.c = sqlite3.connect(self.db, isolation_level=None)
        store.migrate(self.c)

    def tearDown(self):
        self.c.close(); self.tmp.cleanup()

    def test_old_facts_beyond_5000_are_searchable_and_constraints_retained(self):
        critical = add(self.c, 1, 'constraint', 'NEBULEUSE — ne jamais confirmer un envoi sans preuve.')
        add(self.c, 2, 'open_thread', 'Projet Boréal : décision ancienne toujours attendue.')
        for i in range(3, 6103): add(self.c, i, 'completed_action', f'Activité sans rapport numéro {i}')
        found = search(self.c, 'nebuleuse'); self.assertEqual([x['id'] for x in found], [critical])
        body, meta = build_view(self.c, 6102)
        self.assertIn('ne jamais confirmer un envoi sans preuve.', body)
        self.assertIn('REQ-2', body); self.assertTrue(meta['coverage_complete'])
        self.assertLess(len(body.encode()), 24576)

    def test_supersession_current_history_and_both_reference_aliases(self):
        old = add(self.c, 1, 'open_thread', 'ORION ancienne demande')
        done = add(self.c, 2, 'completed_action', 'ORION terminé avec preuve', old, 'work')
        self.assertEqual([x['id'] for x in search(self.c, 'ORION')], [done])
        self.assertEqual(len(search(self.c, 'ORION', history=True)), 2)
        for ref in ('REQ-1', 'AMINE-REQ-1', 'EVT-1'):
            result = search(self.c, ref)[0]
            self.assertEqual(result['state'], 'resolved'); self.assertEqual(result['current']['id'], done)
        self.assertNotIn('REQ-1', build_view(self.c, 2)[0])

    def test_conflicting_replacements_are_not_silently_resolved(self):
        old = add(self.c, 1, 'decision', 'Deux réponses possibles')
        add(self.c, 2, 'decision', 'Réponse A', old); add(self.c, 3, 'decision', 'Réponse B', old)
        self.assertEqual(search(self.c, 'EVT-1')[0]['state'], 'conflict')

    def test_budget_overflow_is_explicit_and_never_truncates_constraints(self):
        text = 'NE PAS EXÉCUTER sans accord explicite. ' * 200
        add(self.c, 1, 'constraint', text)
        body, meta = build_view(self.c, 1, budget_bytes=4096)
        self.assertFalse(meta['coverage_complete']); self.assertEqual(meta['critical_overflow_count'], 1)
        self.assertIn('Coverage: BLOCKED', body); self.assertNotIn(text[:100], body)
        self.assertEqual(search(self.c, 'EVT-1')[0]['current']['text'], text)

    def test_all_old_open_threads_are_indexed_and_counted(self):
        for i in range(1, 81): add(self.c, i, 'open_thread', f'Sujet actif {i} : lire la source avant action.')
        for i in range(81, 901): add(self.c, i, 'checkpoint', f'Observation courante {i}')
        body, meta = build_view(self.c, 900)
        self.assertTrue(meta['coverage_complete']); self.assertEqual(meta['active_counts']['open_thread'], 80)
        for i in range(1, 81): self.assertIn(f'REQ-{i} ', body)

    def test_read_only_lookup_pagination_and_query_escaping(self):
        for i in range(1, 8): add(self.c, i, 'constraint', f'Consigne {i} ponctuation')
        with closing(sqlite3.connect(self.db.as_uri() + '?mode=ro', uri=True)) as reader:
            self.assertEqual(len(search(reader, '', 3, kind='constraint', offset=3)), 3)
            self.assertEqual(search(reader, '" NOT NEAR(*) : impossible'), [])
            self.assertEqual(reader.total_changes, 0)

    def test_index_backfill_and_insert_trigger(self):
        self.c.close(); self.db.unlink()
        self.c = sqlite3.connect(self.db, isolation_level=None)
        self.c.execute('CREATE TABLE events(id TEXT PRIMARY KEY,surface TEXT,kind TEXT,text TEXT,created_at TEXT,ingested_at TEXT,supersedes TEXT,revision INTEGER)')
        add(self.c, 1, 'decision', 'ANTARES souvenir avant index')
        store.migrate(self.c)
        self.assertEqual(len(search(self.c, 'ANTARES')), 1)
        add(self.c, 2, 'decision', 'VEGA nouveau souvenir')
        self.assertEqual(len(search(self.c, 'VEGA')), 1)
        store.migrate(self.c); self.assertEqual(self.c.execute('SELECT count(*) FROM events').fetchone()[0], 2)

    def test_incremental_curator_keeps_events_immutable(self):
        add(self.c, 1, 'learning', 'Fait durable identique', surface='chat')
        add(self.c, 2, 'learning', 'Fait durable identique', surface='work')
        before = list(self.c.execute('SELECT * FROM events'))
        env = dict(os.environ, SAMANTHA_CONTEXT_ROOT=str(self.root))
        def run():
            return json.loads(subprocess.check_output([sys.executable, str(HERE / 'context-dream.py')], env=env, text=True))
        first = run(); second = run()
        self.assertEqual(first['eventsScanned'], 2); self.assertEqual(second['eventsScanned'], 0)
        self.assertEqual(second['newProposals'], 0); self.assertEqual(before, list(self.c.execute('SELECT * FROM events')))
        add(self.c, 3, 'learning', 'Fait durable identique', surface='voice')
        third = run(); self.assertEqual(third['eventsScanned'], 1)
        self.assertTrue(any(x['action'] == 'consolidate_duplicate' for x in third['proposals']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
