#!/usr/bin/env python3
"""Amine 12/10 « relire, ordonner, nettoyer la mémoire partagée » : a reviewed plan goes through the
canonical supersession of context-retire-telemetry.py (backup, receipt, ingest_file require_active)."""
import hashlib, importlib.util, json, os, sqlite3, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('review_store', HERE / 'context-store.py')
store = importlib.util.module_from_spec(spec); spec.loader.exec_module(store)
ACTIVE = "NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes=e.id)"


class ReviewPlan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name) / 'context-sync'
        self.root.mkdir(mode=0o700)
        with sqlite3.connect(self.root / 'memory.db', isolation_level=None) as c:
            store.migrate(c)
            self.stale = self.event(c, 1, 'open_thread', 'Fil clos depuis le 01/10 : recette faite.')
            self.old = self.event(c, 2, 'decision', 'Dreaming à 03:00.')
            self.keep = self.event(c, 3, 'decision', 'La mémoire partagée reste memory.db.')
            store.migrate(c)
        self.plan = Path(self.tmp.name) / 'plan.json'

    def tearDown(self): self.tmp.cleanup()

    def event(self, c, n, kind, text):
        eid = hashlib.sha256(f'review-fixture-{n}'.encode()).hexdigest()
        c.execute('INSERT INTO events(id,revision,surface,kind,text,created_at) VALUES(?,?,?,?,?,?)',
                  (eid, n, 'chat', kind, text, '2026-10-01T10:00:00+00:00'))
        return eid

    def run_plan(self, items, *extra):
        self.plan.write_text(json.dumps({'items': items}))
        env = {**os.environ, 'SAMANTHA_CONTEXT_ROOT': str(self.root)}
        return subprocess.run([sys.executable, str(HERE / 'context-retire-telemetry.py'), '--plan', str(self.plan),
                               '--operation-id', 'review-test', '--backup-dir', str(Path(self.tmp.name) / 'bk'), '--no-compact', *extra],
                              capture_output=True, text=True, env=env)

    def active(self):
        with sqlite3.connect(self.root / 'memory.db') as c:
            return {r[0]: (r[1], r[2]) for r in c.execute(f'SELECT e.id,e.kind,e.text FROM events e WHERE {ACTIVE}')}

    def items(self):
        return [{'target': self.stale, 'action': 'retire', 'reason': 'fil clos, recette faite'},
                {'target': self.old, 'action': 'replace', 'reason': 'horaire périmé', 'text': 'Dreaming à 22:00, curateur à 22:10.'}]

    def test_dry_run_writes_nothing(self):
        r = self.run_plan(self.items(), '--dry-run'); self.assertEqual(0, r.returncode, r.stderr)
        out = json.loads(r.stdout); self.assertEqual(2, out['wouldRetire']['review']); self.assertEqual(0, out['writes'])
        self.assertEqual(3, len(self.active()))

    def test_apply_retires_and_replaces_then_rerun_is_a_no_op(self):
        r = self.run_plan(self.items(), '--apply'); self.assertEqual(0, r.returncode, r.stderr)
        out = json.loads(r.stdout); self.assertEqual(2, out['inserted']); self.assertTrue(Path(out['backup']).exists())
        active = self.active()
        self.assertNotIn(self.stale, active); self.assertNotIn(self.old, active); self.assertIn(self.keep, active)
        self.assertIn(('decision', 'Dreaming à 22:00, curateur à 22:10.'), active.values())
        receipt = [t for k, t in active.values() if t.startswith('MEMORY_RETIRE_V1 ')]
        self.assertEqual(1, len(receipt)); self.assertIn('fil clos', receipt[0])
        again = self.run_plan(self.items(), '--apply'); self.assertEqual(0, again.returncode, again.stderr)
        self.assertEqual('nothing_to_do', json.loads(again.stdout)['state']); self.assertEqual(active, self.active())

    def test_secret_or_telemetry_replacement_is_refused_before_any_write(self):
        for text in ('Le password est hunter2', 'Companion déployé 8a9e7f31aaaa (précédent 0b624504bbbb), recette automatique acceptée.'):
            r = self.run_plan([{'target': self.old, 'action': 'replace', 'reason': 'test refus', 'text': text}], '--apply')
            self.assertNotEqual(0, r.returncode); self.assertIn('invalid_replacement', r.stderr)
        self.assertEqual(3, len(self.active())); self.assertFalse((Path(self.tmp.name) / 'bk').exists())

    def test_malformed_plan_is_refused(self):
        for items in ([{'target': self.old, 'action': 'delete', 'reason': 'non'}],
                      [{'target': self.old, 'action': 'retire', 'reason': ''}],
                      [{'target': self.old, 'action': 'retire', 'reason': 'deux fois'}] * 2):
            r = self.run_plan(items, '--apply'); self.assertNotEqual(0, r.returncode); self.assertIn('invalid_plan_item', r.stderr)
        self.assertEqual(3, len(self.active()))


if __name__ == '__main__':
    unittest.main()
