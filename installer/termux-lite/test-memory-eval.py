#!/data/data/com.termux/files/usr/bin/python3
"""Unit tests for memory-eval.py on a tiny synthetic memory.db (no S24, no model)."""
import contextlib
import importlib.util
import io
import json
import pathlib
import re
import shutil
import sqlite3
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('memory_eval', HERE / 'memory-eval.py')
ev = importlib.util.module_from_spec(spec); spec.loader.exec_module(ev)

tmp = pathlib.Path(tempfile.mkdtemp(prefix='samantha-memory-eval-test.'))
db = tmp / 'memory.db'
con = sqlite3.connect(db)
con.execute('CREATE TABLE events(id TEXT PRIMARY KEY,surface TEXT,kind TEXT,text TEXT,created_at TEXT,ingested_at TEXT, supersedes TEXT, revision INTEGER, session_id TEXT)')
rows = [
    ('a' * 64, 'claude', 'decision', 'Salutation : « Bonjour Amine », jamais « Ahla ».', None),
    ('b' * 64, 'chat', 'constraint', 'Un seul job lourd à la fois sur le S24.', None),
    ('c' * 64, 'work', 'decision', 'Dreaming 03:00 Africa/Tunis.', None),
    ('d' * 64, 'work', 'decision', 'Dreaming passé à 22h Africa/Tunis.', 'c' * 64),
    ('e' * 64, 'chat', 'open_thread', 'Google Tasks natif : briefing de 10:00.', None),
]
for revision, (eid, surface, kind, text, sup) in enumerate(rows, 1):
    con.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,NULL)', (eid, surface, kind, text, '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z', sup, revision))
con.commit(); con.close()

questions = tmp / 'q.jsonl'
qs = [
    {'id': 'T1', 'category': 'preference', 'question': 'Salutation ?', 'expected': ['bonjour amine'], 'source_event_ids': ['a' * 64], 'created_at': 'x'},
    {'id': 'T2', 'category': 'constraint', 'question': 'Jobs ?', 'expected': ['un seul job lourd a la fois'], 'source_event_ids': ['b' * 64], 'created_at': 'x'},
    {'id': 'T3', 'category': 'contradiction', 'question': 'Dreaming ?', 'expected': ['22h Africa/Tunis'], 'stale': ['03:00'], 'source_event_ids': ['d' * 64], 'created_at': 'x'},
    {'id': 'T4', 'category': 'open_thread', 'question': 'Briefing ?', 'expected': [['briefing', '10:00']], 'source_event_ids': ['e' * 64], 'created_at': 'x'},
    {'id': 'T5', 'category': 'decision', 'question': 'Absent ?', 'expected': ['rétention 90 jours'], 'source_event_ids': [], 'created_at': 'x'},
    {'id': 'T6', 'category': 'negative', 'question': 'Date de sortie ?', 'expected': [], 'forbidden': ['sortie le'], 'source_event_ids': [], 'created_at': 'x'},
]
questions.write_text(''.join(json.dumps(q, ensure_ascii=False) + '\n' for q in qs))

tests = []
def T(name, fn):
    try: fn(); tests.append((name, 'PASS', ''))
    except Exception as exc: tests.append((name, 'FAIL', repr(exc)))

def run(*args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = ev.main([*args, '--questions', str(questions)])
    return code, json.loads(out.getvalue())

def t1():
    assert ev.norm('« Réécriture »  d’Amine') == "reecriture d'amine"
T('E01 normalization: accents, quotes, apostrophes', t1)

def t2():
    code, out = run('retrieval', '--db', str(db))
    assert code == 0 and out['total'] == 6 and out['found'] == 5, out
    assert out['missing'] == ['T5'] and out['stale_present'] == [], out
    assert out['view']['coverage_complete'] is True
T('E02 retrieval on rebuilt HYBRID view; superseded fact not shown', t2)

def t3():
    before = db.read_bytes()
    run('retrieval', '--db', str(db)); assert db.read_bytes() == before
    names = {r[0] for r in sqlite3.connect(db).execute("select name from sqlite_master")}
    assert names == {'events', 'sqlite_autoindex_events_1'}, names
T('E03 db opened read-only (no index, no FTS, no write)', t3)

def t4():
    hy = tmp / 'HYBRID.md'; hy.write_text('Dreaming 03:00 et Bonjour Amine')
    code, out = run('retrieval', '--hybrid', str(hy), '--min-found', '6')
    assert code == 1 and 'T3' in out['missing'] and out['stale_present'] == ['T3'], out
T('E04 materialized HYBRID: stale value flagged, min-found gate', t4)

def t5():
    rule = tmp / 'memory.md'; rule.write_text('Retention 90 jours.')
    code, out = run('retrieval', '--db', str(db), '--rules', str(rule))
    assert out['found'] == 6 and out['missing'] == [], out
T('E05 rule files extend the context', t5)

def t6():
    answers = tmp / 'answers.jsonl'
    answers.write_text('\n'.join(json.dumps(x, ensure_ascii=False) for x in [
        {'id': 'T1', 'answer': 'Je dis « Bonjour Amine ».'},
        {'id': 'T2', 'answer': 'Deux jobs.'},
        {'id': 'T3', 'answer': 'À 22h Africa/Tunis (avant : 03:00).'},
        {'id': 'T4', 'answer': 'Le briefing est à 10:00.'},
        {'id': 'T6', 'answer': "Je ne sais pas : aucune décision n'est enregistrée."},
    ]) + '\n')
    code, out = run('answer', '--answers', str(answers))
    assert out['correct'] == 3 and out['wrong'] == ['T2', 'T3'] and out['unanswered'] == ['T5'], out
T('E06 answer mode: key phrase, stale answer rejected, abstention', t6)

def t7():
    items = ev.load_questions(ev.DEFAULT_QUESTIONS)
    assert len(items) == 50
    cats = {i['category'] for i in items}
    assert {'decision', 'constraint', 'preference', 'open_thread', 'recent', 'older', 'cross_surface', 'negative'} <= cats, cats
    for i in items:
        assert all(re.fullmatch(r'[0-9a-f]{64}', s) for s in i['source_event_ids']), i['id']
        assert (i['category'] == 'negative') == (not i['source_event_ids']), i['id']
    raw = json.dumps([[i['question'], i['expected'], i.get('forbidden', []), i.get('stale', [])] for i in items], ensure_ascii=False)
    assert not re.search(r'(?i)(\+?\d[ .-]?){8,}|[\w.+-]+@[\w-]+\.[\w.]+|otp|password|token|cvv|iban', raw)
T('E07 real fixture: 50 questions, categories, sourced, no personal data', t7)

for name, status, err in tests:
    print(f'{status} {name}' + (f' :: {err}' if err else ''))
failed = [t for t in tests if t[1] != 'PASS']
print(f'RESULT {len(tests) - len(failed)}/{len(tests)} PASS')
shutil.rmtree(tmp, ignore_errors=True)
raise SystemExit(1 if failed else 0)
