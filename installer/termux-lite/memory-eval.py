#!/data/data/com.termux/files/usr/bin/python3
"""M5 memory evaluation: deterministic, read-only, no model call.

retrieval: are the expected key facts present in the context Samantha actually
           receives? Context = the bounded HYBRID view rebuilt by
           context_memory.build_view from a memory.db (opened read-only), or an
           already materialized HYBRID file, plus optional rule files.
answer:    score a JSONL file of model answers ({"id","answer"}) by key phrase.

Question format (fixtures/memory-eval/questions.jsonl): id, category, question,
expected (list of acceptable answers; an answer is a phrase or a list of phrases
that must all appear), source_event_ids, created_at; optional stale (outdated
phrases that must not be the answer) and forbidden (negative questions).
Negative questions (category "negative") expect an abstention.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys
import unicodedata

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
DEFAULT_QUESTIONS = HERE / 'fixtures/memory-eval/questions.jsonl'
ABSTAIN = ('je ne sais pas', "je n'ai pas cette information", "je n'ai aucune information",
           'aucune decision', "pas de decision", "n'a pas ete decide", "rien n'a ete decide",
           'pas encore decide', 'aucune information')
QUOTES = dict.fromkeys(map(ord, '«»“”„"'), ' ')
QUOTES.update({ord('’'): "'", ord('‘'): "'", ord(' '): ' ', ord(' '): ' '})


def norm(text):
    """Casefold, drop accents and typographic quotes, collapse whitespace."""
    text = unicodedata.normalize('NFKD', str(text).translate(QUOTES))
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    return ' '.join(text.casefold().split())


def load_questions(path):
    items = []
    for number, line in enumerate(Path(path).read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            continue
        item = json.loads(line)
        for key in ('id', 'category', 'question', 'expected', 'source_event_ids', 'created_at'):
            if key not in item:
                raise ValueError(f'line {number}: missing {key}')
        if item['category'] != 'negative' and not item['expected']:
            raise ValueError(f"line {number}: {item['id']} has no expected answer")
        items.append(item)
    if len({item['id'] for item in items}) != len(items):
        raise ValueError('duplicate question id')
    return items


def matches(alternatives, haystack):
    """True when one acceptable answer is fully present (all its phrases)."""
    for alternative in alternatives:
        phrases = [alternative] if isinstance(alternative, str) else alternative
        if phrases and all(norm(phrase) in haystack for phrase in phrases):
            return True
    return False


def any_phrase(phrases, haystack):
    return [phrase for phrase in phrases or () if norm(phrase) in haystack]


def build_context(db=None, hybrid=None, rules=(), budget_bytes=None):
    parts, meta = [], {}
    if db:
        from context_memory import build_view, VIEW_BUDGET_BYTES
        connection = sqlite3.connect(f'file:{Path(db).resolve()}?mode=ro', uri=True)
        try:
            head = connection.execute('SELECT COALESCE(MAX(revision),0) FROM events').fetchone()[0]
            body, view = build_view(connection, head, budget_bytes=budget_bytes or VIEW_BUDGET_BYTES)
        finally:
            connection.close()
        parts.append(body)
        meta['view'] = {key: view[key] for key in ('revision', 'budget_bytes', 'rendered_events', 'coverage_complete')}
    if hybrid:
        parts.append(Path(hybrid).read_text(encoding='utf-8', errors='replace'))
    for rule in rules:
        parts.append(Path(rule).read_text(encoding='utf-8', errors='replace'))
    text = '\n'.join(parts)
    meta['context_bytes'] = len(text.encode())
    return text, meta


def score_retrieval(questions, context):
    haystack = norm(context)
    missing, stale, by_category = [], [], {}
    for item in questions:
        if item['category'] == 'negative':
            ok = not any_phrase(item.get('forbidden'), haystack)
        else:
            ok = matches(item['expected'], haystack)
            if any_phrase(item.get('stale'), haystack):
                stale.append(item['id'])
        bucket = by_category.setdefault(item['category'], {'total': 0, 'found': 0})
        bucket['total'] += 1; bucket['found'] += int(ok)
        if not ok:
            missing.append(item['id'])
    return {'mode': 'retrieval', 'total': len(questions), 'found': len(questions) - len(missing),
            'missing': missing, 'stale_present': stale, 'by_category': by_category}


def load_answers(path):
    answers = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if line.strip():
            row = json.loads(line)
            answers[str(row['id'])] = str(row.get('answer') or '')
    return answers


def score_answers(questions, answers):
    wrong, unanswered, by_category = [], [], {}
    for item in questions:
        answer = answers.get(item['id'])
        if answer is None:
            unanswered.append(item['id']); ok = False
        else:
            text = norm(answer)
            if item['category'] == 'negative':
                ok = matches(ABSTAIN, text) and not any_phrase(item.get('forbidden'), text)
            else:
                ok = matches(item['expected'], text) and not any_phrase(item.get('stale'), text)
            if not ok:
                wrong.append(item['id'])
        bucket = by_category.setdefault(item['category'], {'total': 0, 'correct': 0})
        bucket['total'] += 1; bucket['correct'] += int(ok)
    correct = len(questions) - len(wrong) - len(unanswered)
    return {'mode': 'answer', 'total': len(questions), 'correct': correct,
            'wrong': wrong, 'unanswered': unanswered, 'by_category': by_category}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('mode', choices=('retrieval', 'answer'))
    parser.add_argument('--questions', default=str(DEFAULT_QUESTIONS))
    parser.add_argument('--db', help='memory.db (opened read-only); rebuilds the HYBRID view')
    parser.add_argument('--hybrid', help='materialized HYBRID_CONTEXT.md to read as is')
    parser.add_argument('--rules', action='append', default=[], help='extra rule file in context (repeatable)')
    parser.add_argument('--budget-bytes', type=int, default=None)
    parser.add_argument('--answers', help='JSONL {"id","answer"} for mode answer')
    parser.add_argument('--min-found', type=int, default=0, help='exit 1 below this score')
    args = parser.parse_args(argv)
    questions = load_questions(args.questions)
    if args.mode == 'retrieval':
        if not (args.db or args.hybrid or args.rules):
            parser.error('retrieval needs --db, --hybrid or --rules')
        context, meta = build_context(args.db, args.hybrid, args.rules, args.budget_bytes)
        result = score_retrieval(questions, context); result.update(meta)
        score = result['found']
    else:
        if not args.answers:
            parser.error('answer needs --answers')
        result = score_answers(questions, load_answers(args.answers))
        score = result['correct']
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 1 if score < args.min_found else 0


if __name__ == '__main__':
    raise SystemExit(main())
