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

    def test_constraint_index_is_sourced_and_never_presents_an_excerpt_as_complete(self):
        text = 'NE PAS EXÉCUTER sans accord explicite. ' * 200
        add(self.c, 1, 'constraint', text)
        body, meta = build_view(self.c, 1, budget_bytes=4096)
        self.assertTrue(meta['coverage_complete']); self.assertEqual(meta['critical_overflow_count'], 0)
        self.assertIn('EVT-1 [chat/constraint]', body)
        self.assertIn('aperçu ; lire la source avant utilisation', body)
        self.assertNotIn(text, body)
        self.assertEqual(search(self.c, 'EVT-1')[0]['current']['text'], text)

    def test_all_old_open_threads_are_indexed_and_counted(self):
        for i in range(1, 81): add(self.c, i, 'open_thread', f'Sujet actif {i} : lire la source avant action.')
        for i in range(81, 901): add(self.c, i, 'checkpoint', f'Observation courante {i}')
        body, meta = build_view(self.c, 900)
        self.assertTrue(meta['coverage_complete']); self.assertEqual(meta['active_counts']['open_thread'], 80)
        for i in range(1, 81): self.assertIn(f'REQ-{i} ', body)

    def test_recent_decisions_survive_a_view_saturated_by_constraints_and_threads(self):
        # S24 11/10: 24 constraints (11.9 KB) + 47 threads left 0 byte for decisions; « Bonjour Amine » never surfaced.
        rev = 0
        for i in range(24):
            rev += 1; add(self.c, rev, 'constraint', f'Contrainte {i} : ' + 'ne jamais agir sans preuve explicite. ' * 12)
        for i in range(47):
            rev += 1; add(self.c, rev, 'open_thread', f'Fil {i} : ' + 'travail en cours avec beaucoup de détails. ' * 20)
        for i in range(40):
            rev += 1; add(self.c, rev, 'checkpoint', f'SITUATION_EVENT_V1 {{"n": {i}}}')
        rev += 1; add(self.c, rev, 'decision', 'Salutation : « Bonjour Amine », jamais « Ahla ».')
        body, meta = build_view(self.c, rev, foundation_bytes=1500)
        self.assertIn('« Bonjour Amine », jamais « Ahla »', body)
        self.assertNotIn('SITUATION_EVENT_V1', body)
        # M1 caps the projection at 16 KiB and keeps a complete sourced index
        # instead of letting full constraint bodies displace decisions.
        self.assertTrue(meta['coverage_complete'])
        for i in range(25, 72): self.assertIn(f'REQ-{i} ', body + ' ')
        self.assertLessEqual(len(body.encode()) + 1500, 16384)

    def test_decisions_older_than_two_days_keep_a_reserved_share(self):
        rev = 0
        for i in range(24):
            rev += 1
            add(self.c, rev, 'decision', f'Décision récente {i} : ' + 'contexte courant ' * 24)
            self.c.execute('UPDATE events SET created_at=? WHERE revision=?', ('2026-10-12T12:00:00Z', rev))
        for marker in ('ORION', 'VEGA', 'ALTAIR'):
            rev += 1
            add(self.c, rev, 'decision', f'Décision historique {marker} : conserver cette information au-delà de deux jours.')
            self.c.execute('UPDATE events SET created_at=? WHERE revision=?', ('2026-10-08T12:00:00Z', rev))
        rev += 1
        add(self.c, rev, 'checkpoint', 'Horodatage historique invalide mais événement conservé')
        self.c.execute('UPDATE events SET created_at=? WHERE revision=?', ('not-a-date', rev))
        body, meta = build_view(self.c, rev)
        for marker in ('ORION', 'VEGA', 'ALTAIR'):
            self.assertIn(f'Décision historique {marker}', body)
        self.assertEqual(meta['older_decisions_rendered'], 3)
        self.assertGreater(meta['reserved_bytes']['older_decisions'], 0)
        self.assertLessEqual(len(body.encode()), 16384)

    def test_newest_thread_keeps_detail_beyond_the_old_90_character_cut(self):
        for rev in range(1, 30):
            add(self.c, rev, 'open_thread', f'Fil ancien {rev} : vérifier le détail dans la source.')
        text = ('Préambule documenté qui occupait auparavant toute la limite courte. ' * 2
                + 'Le briefing Google Tasks est prévu à 10:00 et permet ajout et complétion confirmée.')
        add(self.c, 30, 'open_thread', text)
        body, meta = build_view(self.c, 30)
        self.assertIn('briefing Google Tasks est prévu à 10:00', body)
        self.assertIn('ajout et complétion confirmée', body)
        self.assertEqual(meta['thread_overflow_count'], 0)
        self.assertLessEqual(len(body.encode()), 16384)

    def test_telemetry_never_fills_recent_activity(self):
        add(self.c, 1, 'learning', 'LEARNING_GATE_V2 bruit machine')
        add(self.c, 2, 'checkpoint', 'Companion déployé abc123')
        add(self.c, 3, 'completed_action', 'Factures corrigées et vérifiées')
        body, _ = build_view(self.c, 3)
        self.assertIn('Factures corrigées', body)
        self.assertNotIn('LEARNING_GATE_V2', body); self.assertNotIn('Companion déployé', body)
        self.assertEqual(search(self.c, 'LEARNING_GATE_V2')[0]['revision'], 1)

    def test_every_fact_line_carries_its_tunis_date(self):
        # Doc 49 M3: dated facts. 2026-01-01T00:00Z is 01/01 01:00 in Tunis.
        add(self.c, 1, 'constraint', 'Toujours dire Bonjour Amine')
        add(self.c, 2, 'open_thread', 'Relancer la SEREPT')
        add(self.c, 3, 'decision', 'Dreaming à 22:00')
        body, _ = build_view(self.c, 3)
        self.assertIn('- EVT-1 [chat/constraint] 01/01 Toujours dire Bonjour Amine', body)
        self.assertIn('- 01/01 [chat/decision] Dreaming à 22:00', body)
        self.assertIn('- REQ-2 [chat] 01/01 Relancer la SEREPT', body)

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
        env = dict(os.environ, SAMANTHA_CONTEXT_ROOT=str(self.root), HOME=str(self.root))
        def run():
            return json.loads(subprocess.check_output([sys.executable, str(HERE / 'context-dream.py')], env=env, text=True))
        first = run(); second = run()
        self.assertEqual(first['eventsScanned'], 2); self.assertEqual(second['eventsScanned'], 0)
        self.assertEqual(second['newProposals'], 0); self.assertEqual(before, list(self.c.execute('SELECT * FROM events')))
        add(self.c, 3, 'learning', 'Fait durable identique', surface='voice')
        third = run(); self.assertEqual(third['eventsScanned'], 1)
        self.assertTrue(any(x['action'] == 'consolidate_duplicate' for x in third['proposals']))


SITUATION = 'SITUATION_EVENT_V1: {"event":"EVT-ABC","id":"SIT-X","kind":"transition","state":"analyzing","title":"t"}'
GATE = 'LEARNING_GATE_V1:{"source":"incident","closure_id":"c1","status":"recovered"}'
DEPLOY = 'Companion déployé 0123456789ab (précédent ba9876543210), recette automatique acceptée.'
IMPROVEMENT = 'IMPROVEMENT_CANDIDATE_V1:{"target":"x","intent":"y","type":"rule","current_state":{},"proposed_state":{}}'


class TelemetryOutOfMemoryTests(unittest.TestCase):
    """M3 « une seule mémoire » : machine telemetry stays with its canonical owner."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name) / 'context-sync'
        self.root.mkdir(); (self.root / 'pending').mkdir()
        self.saved = (store.D, store.DB); store.D, store.DB = self.root, self.root / 'memory.db'
        self.c = store.connect(); store.migrate(self.c)
        self.env = dict(os.environ, SAMANTHA_CONTEXT_ROOT=str(self.root), HOME=self.tmp.name)

    def tearDown(self):
        self.c.close(); store.D, store.DB = self.saved; self.tmp.cleanup()

    def pending(self, text, kind='checkpoint', surface='work', folder='pending'):
        eid = hashlib.sha256(text.encode()).hexdigest()
        path = self.root / folder / (eid + '.json'); path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({'version': 2, 'id': eid, 'surface': surface, 'kind': kind, 'text': text,
                                    'createdAt': '2026-10-11T00:00:00Z'}))
        return path

    def test_ingress_refuses_owned_telemetry_but_keeps_legitimate_text(self):
        for text in (SITUATION, GATE, DEPLOY, '  ' + DEPLOY.replace(' ', '  ')):
            with self.assertRaisesRegex(ValueError, 'machine_telemetry_refused'):
                store.ingest_file(self.c, self.pending(text))
        for text in (IMPROVEMENT, 'Companion déployé hier soir, tout va bien', 'SITUATION_SIGNAL_V1:{}'):
            self.assertTrue(store.ingest_file(self.c, self.pending(text, 'learning'))['inserted'])
        # A DB rebuild replays already-accepted processed/ files unchanged.
        self.assertTrue(store.ingest_file(self.c, self.pending(DEPLOY, folder='processed'))['inserted'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM events').fetchone()[0], 4)

    def test_context_event_refuses_before_any_pending_file(self):
        for kind, text in (('checkpoint', SITUATION), ('learning', GATE), ('completed_action', DEPLOY)):
            r = subprocess.run(['bash', str(HERE / 'context-event.sh'), 'work', kind, text], env=self.env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 66, r.stderr); self.assertIn('machine telemetry', r.stderr)
        self.assertEqual(list((self.root / 'pending').iterdir()), [])
        self.assertEqual(self.c.execute('SELECT count(*) FROM events').fetchone()[0], 0)

    def test_producers_no_longer_write_telemetry(self):
        code = [l for l in (HERE / 'companion-deploy.sh').read_text().splitlines() if not l.lstrip().startswith('#')]
        self.assertEqual([l for l in code if 'context-event' in l or 'Companion déployé' in l], [])
        runtime = Path(self.tmp.name) / 'runtime'; runtime.mkdir(); log = Path(self.tmp.name) / 'events.log'
        (runtime / 'context-event.sh').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$EVENT_LOG"\n')
        for text in (GATE, IMPROVEMENT):
            gate = json.dumps({'receipt_id': 'r1', 'context_text': text})
            (runtime / 'learning-gate.py').write_text('#!/usr/bin/env python3\nprint(' + repr(gate) + ')\n')
            for name in ('context-event.sh', 'learning-gate.py'): (runtime / name).chmod(0o755)
            env = dict(self.env, CLAW_RUNTIME_ROOT=str(runtime), EVENT_LOG=str(log), SAMANTHA_UI_PLAYBOOKS_ROOT=str(runtime / 'absent'))
            r = subprocess.run(['bash', str(HERE / 'learning-gate-close.sh'), '--source', 'manual'], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)['context_text'], text)
        written = log.read_text()
        self.assertNotIn('LEARNING_GATE_V1', written); self.assertIn('IMPROVEMENT_CANDIDATE_V1:', written)

    def seed(self):
        ids = {}
        for rev, kind, text in ((1, 'checkpoint', SITUATION), (2, 'learning', GATE), (3, 'completed_action', DEPLOY),
                                (4, 'learning', IMPROVEMENT), (5, 'learning', IMPROVEMENT + ' '),
                                (6, 'decision', 'Décision durable ORION'), (7, 'checkpoint', 'Point de reprise ORION')):
            ids[rev] = add(self.c, rev, kind, text, surface='work')
        self.c.execute("UPDATE memory_meta SET value='7' WHERE key='current_revision'")
        self.c.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('curator_revision_v1','7')")
        # rev 4 was bridged by the improvement bridge; rev 5 is still waiting: it must stay.
        self.c.execute("INSERT INTO dream_proposals VALUES('p4','run','improvement_candidate',?,'{}','bridged','2026-10-08',NULL)", (json.dumps([ids[4]]),))
        self.c.execute("INSERT INTO dream_proposals VALUES('p5','run','improvement_candidate',?,'{}','proposed','2026-10-08',NULL)", (json.dumps([ids[5]]),))
        return ids

    def retire(self, *args):
        r = subprocess.run([sys.executable, str(HERE / 'context-retire-telemetry.py'), '--no-compact',
                            '--backup-dir', str(Path(self.tmp.name) / 'backups'), *args], env=self.env, capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout) if r.stdout.strip() else r.stderr

    def test_retirement_dry_run_counts_then_supersedes_through_the_store(self):
        ids = self.seed(); before = list(self.c.execute('SELECT * FROM events ORDER BY revision'))
        rc, dry = self.retire('--dry-run')
        self.assertEqual(rc, 0); self.assertEqual(dry['writes'], 0)
        self.assertEqual(dry['wouldRetire'], {'situation_event': 1, 'learning_gate': 1, 'companion_deploy': 1, 'improvement_candidate': 1, 'total': 4})
        self.assertEqual(before, list(self.c.execute('SELECT * FROM events ORDER BY revision')))
        self.assertFalse((Path(self.tmp.name) / 'backups').exists())
        rc, out = self.retire('--apply')
        self.assertEqual(rc, 0, out); self.assertEqual(out['inserted'], 4)
        # Immutable: every original row is unchanged; only new supersession receipts were appended.
        self.assertEqual(before, list(self.c.execute('SELECT * FROM events WHERE revision<=7 ORDER BY revision')))
        superseded = {r[0] for r in self.c.execute('SELECT supersedes FROM events WHERE revision>7')}
        self.assertEqual(superseded, {ids[1], ids[2], ids[3], ids[4]})
        backup = Path(out['backup']); self.assertEqual(oct(backup.stat().st_mode & 0o777), '0o600')
        with closing(sqlite3.connect(backup)) as b: self.assertEqual(b.execute('SELECT count(*) FROM events').fetchone()[0], 7)
        body, meta = build_view(self.c, 11)
        self.assertEqual(meta['active_counts'], {'learning': 1, 'decision': 1, 'checkpoint': 1})
        self.assertNotIn('MEMORY_RETIRE_V1', body); self.assertIn('Point de reprise ORION', body)
        self.assertEqual(search(self.c, 'situation_events'), [])
        self.assertEqual(len(search(self.c, 'LEARNING_GATE_V1', history=True)), 1)
        rc, again = self.retire('--apply'); self.assertEqual(again['state'], 'nothing_to_do')
        self.assertEqual(self.retire('--dry-run')[1]['wouldRetire']['total'], 0)

    def test_retirement_is_reversible_only_without_foreign_writes(self):
        self.seed()
        rc, out = self.retire('--apply'); manifest = out['manifest']
        self.assertEqual(self.retire('--restore', manifest)[1]['state'], 'ready')
        add(self.c, 99, 'decision', 'Écriture étrangère après le retrait')
        rc, refused = self.retire('--restore', manifest, '--apply')
        self.assertEqual((rc, refused['reason']), (1, 'memory_advanced_since_retirement'))
        # Without the foreign write, the pre-run backup comes back and receipts leave processed/.
        self.tearDown(); self.setUp(); self.seed(); before = list(self.c.execute('SELECT id FROM events ORDER BY revision'))
        rc, out = self.retire('--apply')
        rc, restored = self.retire('--restore', out['manifest'], '--apply')
        self.assertEqual(restored['state'], 'restored', restored); self.assertEqual(restored['receiptFilesParked'], 4)
        self.c.close(); self.c = store.connect()
        self.assertEqual(before, list(self.c.execute('SELECT id FROM events ORDER BY revision')))
        self.assertEqual(list((self.root / 'processed').glob('*.json')), [])

    def test_real_s24_shapes_are_classified_exactly(self):
        fixture = json.loads((HERE.parent.parent / 'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11-m3-telemetry/memory-telemetry-shapes.json').read_text())
        for rev, row in enumerate(fixture['rows'], 1):
            eid = add(self.c, rev, row['kind'], row['text'], surface=row['surface'])
            if row.get('bridged'):
                self.c.execute("INSERT INTO dream_proposals VALUES(?,?,?,?,?,?,?,NULL)", ('p%d' % rev, 'run', 'improvement_candidate', json.dumps([eid]), '{}', 'bridged', '2026-10-08'))
        self.c.execute("INSERT OR REPLACE INTO memory_meta(key,value) VALUES('curator_revision_v1',?)", (str(len(fixture['rows'])),))
        expected = {name: sum(r['class'] == name for r in fixture['rows']) for name in ('situation_event', 'learning_gate', 'companion_deploy', 'improvement_candidate')}
        expected['total'] = sum(expected.values())
        self.assertEqual(self.retire('--dry-run')[1]['wouldRetire'], expected)
        s24 = fixture['s24Counts']
        self.assertEqual(s24['total'], sum(s24[k] for k in ('situation_event', 'learning_gate', 'companion_deploy', 'improvement_candidate')))

    def test_curator_digest_skips_telemetry_and_receipts(self):
        self.seed(); self.c.execute("DELETE FROM memory_meta WHERE key='curator_revision_v1'")
        rc, out = self.retire('--apply'); self.assertEqual(rc, 0, out)
        subprocess.check_output([sys.executable, str(HERE / 'context-dream.py')], env=self.env, text=True)
        cited = set()
        for (ids,) in self.c.execute("SELECT source_ids FROM dream_proposals WHERE action='memory_digest'"): cited |= set(json.loads(ids))
        texts = {r[0] for r in self.c.execute(f"SELECT text FROM events WHERE id IN ({','.join('?' * len(cited))})", tuple(cited))}
        self.assertTrue(texts); self.assertFalse([t for t in texts if t.startswith(('MEMORY_RETIRE_V1', 'SITUATION_EVENT', 'LEARNING_GATE', 'Companion', 'IMPROVEMENT'))])


if __name__ == '__main__':
    unittest.main(verbosity=2)
