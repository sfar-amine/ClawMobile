"""Synthetic acceptance evidence: a draft/pending R20 cannot accept deployment."""
import contextlib, importlib.util, io, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('acceptance', Path(__file__).resolve().parents[2] / 'installer/termux-lite/companion-acceptance.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for code, payload in [(202, {'state': 'warming'}), (200, {'installedSchemaQualified': False})]:
    calls = []
    def fake(method, path, timeout, headers=None):
        calls.append((method, path, headers))
        if method != 'GET':
            return 403, b'{}', .01
        if path.startswith('/files'):
            return code, json.dumps(payload).encode(), .01
        return 404, b'{}', .01
    module.call = fake
    sys.argv = ['acceptance', '--file-session-id', 'fixture', '--file-path', 'notes/read.txt']
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert module.main() == 1
    report = json.loads(output.getvalue())
    assert report['accepted'] is False
    files = [x for x in report['checks'] if x['route'].startswith('/files')]
    assert len(files) == 2 and all(x['status'] == 'pending' for x in files)
    assert any(x['budget'] == 1.5 for x in files) and any(x['budget'] == 2 for x in files)
    assert all(headers is None for _, _, headers in calls)
    assert all(method == 'GET' or '/files' in path or path in dict((p, m) for m,p in module.OWNER_GUARDS) for method,path,_ in calls)
    assert 'notes/read.txt' not in output.getvalue() and 'sessionId=fixture' not in output.getvalue()
print('R20 acceptance fixtures: warming/unqualified cannot accept, dedicated fixture identity omitted from report, no owner header sent')
