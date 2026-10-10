"""Recette UI 10/10: an e-mail address in a response is a warning, never a deploy failure (Amine, 10/10).
Secrets still fail. /agent/config no longer carries the account e-mail (opaque @acct- handles); the captured
pre-fix response is flagged by EMAIL, not by LEAK."""
import importlib.util, json
from pathlib import Path
here = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('acceptance', here.parents[2] / 'installer/termux-lite/companion-acceptance.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
captures = here.parents[1] / 'fixtures/s24-2026-10-10/ui-recette'

before = json.dumps(json.loads((captures / 'companion.agent-config.json').read_text())['response'])
assert m.EMAIL.search(before), 'the captured R6 e-mail must be reported as a warning'
assert not m.LEAK.search(before), 'an e-mail alone must not fail acceptance'
for path in sorted(captures.glob('companion.*.json')):
    body = json.dumps(json.loads(path.read_text())['response'], ensure_ascii=False)
    assert not m.LEAK.search(body), path.name
for text in ['openai/gpt-5.6-sol@acct-0123456789ab', '+21612345678', '2026-11-09T10:20:42.000Z', 'owner@example.invalid']:
    assert not m.LEAK.search(text), text
assert m.EMAIL.search('owner@example.invalid') and not m.EMAIL.search('openai/gpt-5.6-sol@acct-0123456789ab')
for text in ['Bearer abcdefghijkl', 'sk-abcdefghijkl', 'refresh_token']:
    assert m.LEAK.search(text), text
print('acceptance: e-mail reported as warning only, secrets still refused')
