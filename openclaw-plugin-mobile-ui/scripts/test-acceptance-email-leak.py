"""Recette UI 10/10: the deploy acceptance treats an account e-mail as a leak, on the real S24 captures.
Before the fix /agent/config carried one; every other captured read route is e-mail free (fixtures/s24-2026-10-10/ui-recette/measures.json)."""
import importlib.util, json
from pathlib import Path
here = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('acceptance', here.parents[2] / 'installer/termux-lite/companion-acceptance.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
captures = here.parents[1] / 'fixtures/s24-2026-10-10/ui-recette'

before = json.loads((captures / 'companion.agent-config.json').read_text())['response']
assert m.LEAK.search(json.dumps(before)), 'the captured R6 leak must fail acceptance'
for path in sorted(captures.glob('companion.*.json')):
    if path.name == 'companion.agent-config.json':
        continue
    body = json.dumps(json.loads(path.read_text())['response'], ensure_ascii=False)
    assert not m.LEAK.search(body), path.name
# Legitimate shapes stay accepted: opaque account handles, E.164 numbers, model references, ISO dates.
for text in ['openai/gpt-5.6-sol@acct-0123456789ab', 'google/gemini-3.5-flash-lite@acct-abcdefabcdef', '+21612345678',
             '2026-11-09T10:20:42.000Z', 'openai · compte connecté', '{"label":"Toutes les 15 min"}']:
    assert not m.LEAK.search(text), text
for text in ['owner@example.invalid', 'openai:Someone.Name+tag@mail.example.tn', 'Bearer abcdefghijkl']:
    assert m.LEAK.search(text), text
print('acceptance LEAK: account e-mail refused on captured R6 response, other captured read routes and opaque handles accepted')
