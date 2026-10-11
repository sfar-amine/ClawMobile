#!/data/data/com.termux/files/usr/bin/python3
"""M3 « une seule mémoire » : retire existing machine telemetry from the shared memory.

One-shot, operator-run (never scheduled). Default mode is --dry-run: it only counts.

Canonical owner path only. Each target event gets one ``MEMORY_RETIRE_V1`` checkpoint that
supersedes it, written as a pending event and ingested by ``context-store.py``
``ingest_file(require_active=target)`` -- the same path as ``control-forget``. No DELETE, no
UPDATE: history stays complete and searchable with ``history=True``; superseded events leave
the active view, the « Actifs » counts and the default search. Receipts are bookkeeping and are
themselves excluded from counts, recent activity, default search and the curator digest.

Targets (active events only):
- ``SITUATION_EVENT_V1:``  owner skill_intelligence ``situation_events``;
- ``LEARNING_GATE_V<n>:``  owner learning-gate receipts / ledger / DEVELOPMENT_JOURNAL;
- ``Companion déployé <sha> (précédent <sha>), recette automatique acceptée.``
  owner ``~/.openclaw/deploys/companion-*.json``;
- ``IMPROVEMENT_CANDIDATE_V1:`` only once consumed: revision <= curator cursor and cited by a
  non-``proposed`` ``improvement_candidate`` dream proposal (owner: improvement store). The
  improvement bridge reads ``dream_proposals``, never these events, and is not touched.

Apply (``--apply``): backup of memory.db with the SQLite backup API (integrity-checked), manifest,
then supersession; compaction runs once at the end (best effort, like context-event.sh).

Reverse (``--restore MANIFEST``): supersession cannot be undone in the immutable store, so the
reversal restores the pre-run backup, only if nothing but this run's receipts was written since
(otherwise refused). The current DB is backed up first and this run's receipt files are moved out
of ``processed/`` so a history reconciliation never replays them.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from context_memory import ACTIVE, RETIRE_PREFIX, refused_telemetry  # noqa: E402

spec = importlib.util.spec_from_file_location('context_store', HERE / 'context-store.py')
store = importlib.util.module_from_spec(spec); spec.loader.exec_module(store)

OWNERS = {
    'situation_event': 'skill_intelligence.situation_events',
    'learning_gate': 'learning-gate.receipts',
    'companion_deploy': 'deploys.companion_receipts',
    'improvement_candidate': 'skill_intelligence.improvement_candidates',
}
DEFAULT_OPERATION = 'm3-telemetry-retire-20261012'
OPERATION_RE = re.compile(r'[-A-Za-z0-9_.:]{1,128}')


def classify(text):
    text = ' '.join(str(text or '').split())
    if refused_telemetry(text):
        if text.startswith('SITUATION_EVENT_V1:'):
            return 'situation_event'
        if text.startswith('LEARNING_GATE_V'):
            return 'learning_gate'
        return 'companion_deploy'
    if text.startswith('IMPROVEMENT_CANDIDATE_V1:'):
        return 'improvement_candidate'
    return None


def targets(conn, classes):
    """Active telemetry events, oldest first. Read-only."""
    cursor = conn.execute("SELECT value FROM memory_meta WHERE key='curator_revision_v1'").fetchone()
    curator = int(cursor[0]) if cursor else 0
    consumed = set()
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dream_proposals'").fetchone():
        for (source_ids,) in conn.execute("SELECT source_ids FROM dream_proposals WHERE action='improvement_candidate' AND status<>'proposed'"):
            try:
                consumed.update(x for x in json.loads(source_ids) if isinstance(x, str))
            except (ValueError, TypeError):
                continue
    found = []
    sql = (f"SELECT e.id,e.revision,e.kind,e.text FROM events e WHERE {ACTIVE} AND ("
           "substr(e.text,1,19)='SITUATION_EVENT_V1:' OR substr(e.text,1,15)='LEARNING_GATE_V' "
           "OR substr(e.text,1,17)='Companion déployé' OR substr(e.text,1,25)='IMPROVEMENT_CANDIDATE_V1:') ORDER BY e.revision")
    for eid, revision, kind, text in conn.execute(sql):
        cls = classify(text)
        if cls is None or cls not in classes:
            continue
        if cls == 'improvement_candidate' and (kind != 'learning' or revision > curator or eid not in consumed):
            continue
        found.append({'id': eid, 'revision': revision, 'class': cls})
    return found


def counts(items):
    out = {name: 0 for name in OWNERS}
    for item in items:
        out[item['class']] += 1
    out['total'] = len(items)
    return out


def receipt(operation, item):
    identity = hashlib.sha256(('memory-retire\0' + operation + '\0' + item['id']).encode()).hexdigest()
    text = RETIRE_PREFIX + json.dumps({'version': 1, 'operationId': operation, 'target': item['id'],
                                       'class': item['class'], 'owner': OWNERS[item['class']]},
                                      sort_keys=True, separators=(',', ':'))
    return identity, text


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def backup(source_conn, directory, label):
    directory.mkdir(parents=True, exist_ok=True); os.chmod(directory, 0o700)
    stamp = datetime.datetime.now().astimezone().strftime('%Y%m%dT%H%M%S')
    path = directory / f'memory-{label}-{stamp}.db'
    if path.exists():
        raise SystemExit('backup_exists')
    with closing(sqlite3.connect(path)) as dest:
        source_conn.backup(dest)
        if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise SystemExit('backup_integrity_failed')
        copied = dest.execute('SELECT count(*), COALESCE(MAX(revision),0) FROM events').fetchone()
    os.chmod(path, 0o600)
    expected = source_conn.execute('SELECT count(*), COALESCE(MAX(revision),0) FROM events').fetchone()
    if tuple(copied) != tuple(expected):
        raise SystemExit('backup_count_mismatch')
    return path, {'events': copied[0], 'head': copied[1], 'sha256': sha256_file(path)}


def write_json(path, value):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + '\n'); os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def compact(skip):
    if skip:
        return 'skipped'
    try:
        r = subprocess.run([str(HERE / 'context-compact.sh')], capture_output=True, text=True, timeout=300)
        return 'ok' if r.returncode == 0 else 'failed:' + str(r.returncode)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 'failed:' + type(exc).__name__


def retire(args):
    classes = set(args.classes.split(',')) if args.classes else set(OWNERS)
    if not classes <= set(OWNERS):
        raise SystemExit('unknown_class')
    with closing(store.control_read()) as reader:
        items = targets(reader, classes)
        head = reader.execute('SELECT COALESCE(MAX(revision),0) FROM events').fetchone()[0]
        total = reader.execute('SELECT count(*) FROM events').fetchone()[0]
        if not args.apply:
            return {'mode': 'dry-run', 'operationId': args.operation_id, 'memoryEvents': total, 'head': head,
                    'wouldRetire': counts(items), 'firstRevision': items[0]['revision'] if items else None,
                    'lastRevision': items[-1]['revision'] if items else None, 'writes': 0}
    if not items:
        return {'mode': 'apply', 'operationId': args.operation_id, 'retired': counts([]), 'state': 'nothing_to_do'}
    with closing(sqlite3.connect(store.DB, timeout=30)) as source:
        source.execute('PRAGMA busy_timeout=30000')
        path, proof = backup(source, Path(args.backup_dir), args.operation_id.replace(':', '_'))
    manifest_path = path.with_suffix('.manifest.json')
    manifest = {'version': 1, 'operationId': args.operation_id, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'memory': str(store.DB), 'backup': str(path), 'backupProof': proof, 'headBefore': proof['head'],
                'planned': counts(items), 'targets': [x['id'] for x in items], 'receipts': [], 'state': 'started'}
    write_json(manifest_path, manifest)
    pending = store.D / 'pending'; pending.mkdir(parents=True, exist_ok=True)
    if pending.is_symlink():
        raise SystemExit('memory_source_unavailable')
    inserted = skipped = 0; done = []
    with closing(store.connect()) as writer:
        for item in items:
            identity, text = receipt(args.operation_id, item)
            file = pending / (identity + '.json')
            payload = {'version': 2, 'id': identity, 'surface': 'openclaw', 'kind': 'checkpoint', 'text': text,
                       'supersedes': item['id'], 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            try:
                fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w') as stream:
                    json.dump(payload, stream, separators=(',', ':'))
            except FileExistsError:
                pass
            try:
                result = store.ingest_file(writer, file, require_active=item['id'])
                inserted += int(result['inserted']); done.append(identity)
            except ValueError as error:
                if str(error) != 'memory_already_superseded':
                    raise
                file.unlink(missing_ok=True); skipped += 1
        head_after = writer.execute('SELECT COALESCE(MAX(revision),0) FROM events').fetchone()[0]
    manifest.update(receipts=done, headAfter=head_after, inserted=inserted, alreadySuperseded=skipped, state='applied')
    write_json(manifest_path, manifest)
    return {'mode': 'apply', 'operationId': args.operation_id, 'retired': counts(items), 'inserted': inserted,
            'alreadySuperseded': skipped, 'backup': str(path), 'manifest': str(manifest_path),
            'headBefore': proof['head'], 'headAfter': head_after, 'compaction': compact(args.no_compact)}


def restore(args):
    manifest_path = Path(args.restore)
    manifest = json.loads(manifest_path.read_text())
    backup_path = Path(manifest['backup'])
    if sha256_file(backup_path) != manifest['backupProof']['sha256']:
        raise SystemExit('backup_checksum_mismatch')
    receipts = set(manifest.get('receipts') or [])
    with closing(store.control_read()) as reader:
        later = [row[0] for row in reader.execute('SELECT id FROM events WHERE revision>? ORDER BY revision', (manifest['headBefore'],))]
    foreign = [x for x in later if x not in receipts]
    plan = {'mode': 'restore-apply' if args.apply else 'restore-dry-run', 'operationId': manifest['operationId'],
            'backup': str(backup_path), 'receiptsPresent': len(later) - len(foreign), 'foreignEventsSince': len(foreign)}
    if foreign:
        # Never discard someone else's write: the operator decides with both backups in hand.
        return {**plan, 'state': 'refused', 'reason': 'memory_advanced_since_retirement'}
    if not args.apply:
        return {**plan, 'state': 'ready'}
    with closing(sqlite3.connect(store.DB, timeout=30)) as live:
        live.execute('PRAGMA busy_timeout=30000')
        safety, _ = backup(live, Path(args.backup_dir), 'pre-restore-' + manifest['operationId'].replace(':', '_'))
        with closing(sqlite3.connect(backup_path.resolve().as_uri() + '?mode=ro', uri=True)) as source:
            source.backup(live)
    moved = 0
    parked = backup_path.with_suffix('.restored-receipts'); parked.mkdir(mode=0o700, exist_ok=True)
    for identity in receipts:
        for folder in ('processed', 'pending'):
            candidate = store.D / folder / (identity + '.json')
            if candidate.exists():
                shutil.move(str(candidate), str(parked / candidate.name)); moved += 1
    manifest.update(state='restored', restoredAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), preRestoreBackup=str(safety))
    write_json(manifest_path, manifest)
    return {**plan, 'state': 'restored', 'preRestoreBackup': str(safety), 'receiptFilesParked': moved,
            'compaction': compact(args.no_compact)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='count only (default)')
    mode.add_argument('--apply', action='store_true', help='backup, then supersede through context-store.py')
    parser.add_argument('--restore', metavar='MANIFEST', help='reverse a run from its manifest (dry-run unless --apply)')
    parser.add_argument('--operation-id', default=DEFAULT_OPERATION)
    parser.add_argument('--classes', default='', help='comma list among: ' + ','.join(OWNERS))
    parser.add_argument('--backup-dir', default=str(store.D.parent / 'context-backup' / 'm3-telemetry'))
    parser.add_argument('--no-compact', action='store_true')
    args = parser.parse_args(argv)
    if not OPERATION_RE.fullmatch(args.operation_id):
        raise SystemExit('invalid_operation_id')
    out = restore(args) if args.restore else retire(args)
    print(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    return 1 if out.get('state') == 'refused' else 0


if __name__ == '__main__':
    raise SystemExit(main())
