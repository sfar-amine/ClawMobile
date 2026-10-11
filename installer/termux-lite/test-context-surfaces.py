#!/usr/bin/env python3
"""Exercise the actual event/store owner with isolated paths, never runtime HOME."""
import json, os, pathlib, shutil, sqlite3, subprocess, tempfile
SOURCE = pathlib.Path(__file__).resolve().parent
SURFACES = ('chat', 'work', 'voice', 'openclaw', 'claude', 'codex', 'app')
# Real installed-owner evidence: no live semantic voice producer exists yet.
# Exercising the CLI directly below is not a Voice/Claw end-to-end receipt.
fixture = json.loads((SOURCE.parents[1]/'openclaw-plugin-mobile-ui/fixtures/s24-2026-10-10/c5/voice-producers.json').read_text())
assert fixture['_capture']['sanitized'] is True
assert fixture['voiceEvents'] == 0
assert set(fixture['eventsBySurface']) == {'chat', 'work', 'openclaw'}
assert all(row['surface'] != 'voice' for row in fixture['installedProducersCallingContextEventSh'])
assert 'memory.cross_surface' in fixture['capabilitiesMentioningContextEvent']
with tempfile.TemporaryDirectory(prefix='c5-context-surfaces-') as folder:
    root = pathlib.Path(folder)
    scripts = root / 'scripts'; scripts.mkdir()
    for source in SOURCE.glob('context*'):
        if source.is_file() and source.suffix in ('.sh', '.py'):
            target = scripts / source.name
            text = source.read_text()
            if source.suffix == '.sh': text = '#!/usr/bin/env bash\n' + text.split('\n', 1)[1]
            target.write_text(text); target.chmod(0o700)
    state = root / 'existing-context-owner'
    hybrid = root / 'workspace/context/HYBRID_CONTEXT.md'
    hybrid.parent.mkdir(parents=True); hybrid.write_text('# Fixture foundation preserved\n')
    env = dict(os.environ, SAMANTHA_CONTEXT_ROOT=str(state), SAMANTHA_HYBRID_PATH=str(hybrid))
    def event(surface, kind='decision', text='Semantic fixture decision', *extra):
        return subprocess.run(['bash', str(scripts/'context-event.sh'), surface, kind, *extra, text], env=env, text=True, capture_output=True)
    ids = {}
    for surface in SURFACES:
        result = event(surface, text='Explicit semantic fixture '+surface)
        assert result.returncode == 0, (surface, result.returncode)
        ids[surface] = result.stdout.strip(); assert len(ids[surface]) == 64
    connection = sqlite3.connect(state/'memory.db')
    assert {row[0] for row in connection.execute('SELECT surface FROM events')} == set(SURFACES)
    assert connection.execute('SELECT COUNT(*) FROM events').fetchone()[0] == 7
    duplicate = event('codex', text='Explicit semantic fixture codex')
    assert duplicate.returncode == 0 and duplicate.stdout.strip() == ids['codex']
    assert connection.execute('SELECT COUNT(*) FROM events').fetchone()[0] == 7
    refused = event('arbitrary-client'); assert refused.returncode == 64
    refused = event('app', text='OTP 123456'); assert refused.returncode == 65
    assert connection.execute('SELECT COUNT(*) FROM events').fetchone()[0] == 7
    superseded = event('claude', 'decision', 'Replacement decision', '--supersedes', ids['codex'])
    assert superseded.returncode == 0
    row = connection.execute('SELECT surface,supersedes FROM events WHERE id=?', (superseded.stdout.strip(),)).fetchone()
    assert row == ('claude', ids['codex'])
    for surface in ('claude','codex','app'):
        run = event(surface,'open_thread','Session-linked semantic fixture','--session','alpha')
        assert run.returncode == 0
        row = connection.execute('SELECT surface,session_id FROM events WHERE id=?',(run.stdout.strip(),)).fetchone()
        assert row == (surface,'alpha')
    connection.close()
    # Direct-store validation shares the same closed surface set (cannot bypass CLI).
    direct = {'version':2,'id':'f'*64,'surface':'browser','kind':'decision','text':'Invalid source','createdAt':'2026-10-10T00:00:00Z'}
    path = root/'invalid.json'; path.write_text(json.dumps(direct))
    result = subprocess.run(['python3',str(scripts/'context-store.py'),'ingest-file',str(path)], env=env, text=True, capture_output=True)
    assert result.returncode != 0
    assert '# Fixture foundation preserved' in hybrid.read_text()
print('C5: seven closed surfaces, canonical SQLite ingestion, idempotence, cross-surface supersession and secret rejection PASS; real installed-owner absence captured; isolated CLI simulation only, voice producer not qualified')
