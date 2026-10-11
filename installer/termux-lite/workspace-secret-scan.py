#!/usr/bin/env python3
"""Bounded read-only diagnostics. Values never leave this process; no runtime defaults."""
import argparse
import codecs
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time

_spec = importlib.util.spec_from_file_location('acceptance_secret_owner', Path(__file__).with_name('companion-acceptance.py'))
_owner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_owner)
# Reuse the deployed acceptance filter; add only J1-specific classes.
TOKEN = _owner.LEAK
PRIVATE = re.compile(r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----')
JWT = re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}')
OTP = re.compile(r'(?i)\b(?:otp|one[- ]time (?:code|password)|code (?:de verification|de validation))\s*[:=]?\s*(\d{4,8})\b')
CARD = re.compile(r'(?<![\w.\-])(?:[0-9][ -]?){12,18}[0-9](?![\w.\-])')
# Bounded local part/domain (RFC 5321 limits): an unbounded `+` is quadratic on a long minified line.
EMAIL = re.compile(r'\b[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b')
EXCLUDED = {'.git', 'node_modules', 'context', 'context-backup', 'contacts', 'credentials', 'payments'}
# Binary or generated bundles are ignored without reading, never reported as a truncated text file.
BINARY_SUFFIXES = frozenset('''
png jpg jpeg gif webp bmp ico heic avif svgz tif tiff psd pdf
zip gz tgz xz bz2 zst 7z rar tar jar apk aab aar dex so o a class pyc pyo whl
woff woff2 ttf otf eot mp3 mp4 m4a aac ogg opus wav flac webm mkv mov avi
sqlite sqlite3 db db-wal db-shm sqlite-wal sqlite-shm bin dat pack idx onnx tflite gguf pt npz npy map
'''.split())
BLOCK = 64 * 1024          # read and decode a file by blocks
SEGMENT = 64 * 1024        # longest slice of one line matched in one regex pass
OVERLAP = 4 * 1024         # carried between slices so a value on the boundary is still matched once
PRIVATE_NAME = re.compile(r'(?i)(?:\.env(?:\.|$)|credential|secret|token|\.key$|\.pem$|^auth.*\.json$|payment|bank)')


def safe_name(name):
    # A value embedded in a filename is still a value: don't echo it as a path.
    if any(pattern.search(name) for pattern in (TOKEN, JWT, PRIVATE, OTP, EMAIL)) or any(luhn(m.group()) for m in CARD.finditer(name)):
        return '[redacted-name-' + hashlib.sha256(name.encode('utf-8', errors='surrogatepass')).hexdigest()[:16] + ']'
    return name


def luhn(value):
    digits = [int(c) for c in value if c.isdigit()]
    if len(digits) < 13 or len(digits) > 19 or len(set(digits)) == 1:
        return False
    return sum((n * 2 - 9 if n > 4 else n * 2) if i % 2 == len(digits) % 2 else n for i, n in enumerate(digits)) % 10 == 0


def card_candidate(value):
    """Luhn alone admits clock identifiers; apply the explicit numeric context policy."""
    digits = ''.join(c for c in value if c.isdigit())
    if len(digits) in (13, 16, 19) and digits[:2] in ('16', '17', '18'):
        return False
    if re.fullmatch(r'[0-9]{8}-[0-9]{6}', value):
        return False
    return luhn(value)


# Accepted metadata is limited to these exact committed public test sources.
PUBLIC_FIXTURE_PATHS = frozenset({
    'core/installer/termux-lite/test-claw-live-control.py',
    'core/installer/termux-lite/test-claw-live.py',
    'core/installer/termux-lite/test-context-memory.py',
    'core/installer/termux-lite/test-gemini-request.py',
    'core/openclaw-plugin-mobile-ui/scripts/test-file-read-boundary.cjs',
    'core_installer/termux-lite/test-claw-live-control.py',
    'core_installer/termux-lite/test-claw-live.py',
    'core_installer/termux-lite/test-context-memory.py',
    'core_installer/termux-lite/test-gemini-request.py',
    'core_plugin/scripts/test-file-read-boundary.cjs',
})


def accepted_signature_rows():
    # Immutable repository evidence only; no runtime configuration or persistent store.
    path = Path(__file__).with_name('workspace-secret-scan-fixtures.json')
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 128 * 1024:
                return ()
            with os.fdopen(fd, 'r', encoding='utf-8', closefd=False) as source:
                text = source.read(128 * 1024 + 1)
            if len(text) > 128 * 1024:
                return ()
            rows = json.loads(text)
        finally:
            os.close(fd)
        if not isinstance(rows, list) or len(rows) > 1000:
            return ()
        valid = []
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'path', 'type', 'hash', 'raison'}:
                return ()
            parts = row['path'].split('/') if isinstance(row['path'], str) else []
            if (not parts or any(part in ('', '.', '..') for part in parts)
                    or any(part in EXCLUDED for part in parts)
                    or row['type'] not in ('public_fixture', 'card')
                    or not isinstance(row['hash'], str)
                    or not re.fullmatch(r'[a-f0-9]{64}' if row['type'] == 'public_fixture' else r'[a-f0-9]{16}', row['hash'])
                    or not isinstance(row['raison'], str) or not 1 <= len(row['raison']) <= 240):
                return ()
            # No blanket test-file exemption: only a hash-attested committed public file.
            if row['path'] not in PUBLIC_FIXTURE_PATHS:
                return ()
            valid.append(row)
        return tuple(valid)
    except (OSError, ValueError, TypeError, AttributeError):
        return ()


def is_binary_name(name):
    suffix = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    return suffix in BINARY_SUFFIXES


# Android denies read on `/`, `/data` and `/data/data` but grants search: parents are anchored
# with O_PATH (no read needed, still no link followed); only the root itself is opened for reading.
PARENT_FLAGS = getattr(os, 'O_PATH', os.O_RDONLY) | os.O_DIRECTORY


def open_root(path, *, _open=None):
    """Anchor every absolute path component, including parents, without following links."""
    _open = _open or os.open
    parts = Path(path).absolute().parts[1:]
    if not parts:
        return _open('/', os.O_RDONLY | os.O_DIRECTORY)
    fd = _open('/', PARENT_FLAGS)
    try:
        for index, part in enumerate(parts):
            flags = (os.O_RDONLY | os.O_DIRECTORY) if index == len(parts) - 1 else PARENT_FLAGS
            next_fd = _open(part, flags | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def iter_segments(fd, allowance, deadline):
    """Yield (line_number, text_slice, slice_offset, accept_before) while reading by blocks.

    accept_before is None for the last slice of a line, otherwise the absolute offset from which
    matches belong to the next slice. Returns (outcome, bytes_read), outcome in ok/binary/time. A line longer than SEGMENT is
    cut in overlapping slices, so the deadline is also checked inside one huge line."""
    decoder = codecs.getincrementaldecoder('utf-8')('strict')
    pending = ''
    number = 1
    remaining = allowance
    while True:
        if time.monotonic() >= deadline:
            return 'time', allowance - remaining
        block = os.read(fd, min(BLOCK, remaining)) if remaining > 0 else b''
        remaining -= len(block)
        if b'\0' in block:
            return 'binary', allowance - remaining
        try:
            # At the byte allowance a multi-byte character may be cut: that is truncation, not binary.
            pending += decoder.decode(block, final=not block and remaining > 0)
        except UnicodeError:
            return 'binary', allowance - remaining
        pieces = pending.splitlines(keepends=True)
        # Keep the last unterminated piece (or a lone '\r' that may precede '\n') for the next block.
        tail = ''
        if block and pieces and (pieces[-1] == pieces[-1].rstrip('\r\n\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029') or pieces[-1].endswith('\r')):
            tail = pieces.pop()
        for piece in pieces:
            line = piece.rstrip('\r\n\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029')
            start = 0
            while len(line) - start > SEGMENT + OVERLAP:
                yield number, line[start:start + SEGMENT + OVERLAP], start, start + SEGMENT
                start += SEGMENT
                if time.monotonic() >= deadline:
                    return 'time', allowance - remaining
            yield number, line[start:], start, None
            number += 1
        # An unterminated line that grows past one slice is matched now instead of being buffered.
        while len(tail) > SEGMENT + OVERLAP:
            yield number, tail[:SEGMENT + OVERLAP], 0, SEGMENT
            tail = tail[SEGMENT:]
            if time.monotonic() >= deadline:
                return 'time', allowance - remaining
        pending = tail
        if not block:
            return 'ok', allowance - remaining


def scan_roots(roots, *, max_files=10000, max_bytes=64*1024*1024, file_bytes=1024*1024, max_entries=20000, max_findings=1000, seconds=10):
    roots = list(roots)
    if len(roots) > 8 or len({label for label, _ in roots}) != len(roots):
        raise ValueError('invalid_root_count')
    result = {'schemaVersion': 1, 'state': 'ok', 'findings': [], 'warnings': [], 'accepted': [], 'roots': [], 'stats': {'files': 0, 'bytes': 0, 'entries': 0, 'skipped': 0, 'binary': 0}}
    global_deadline = time.monotonic() + seconds
    deadline = global_deadline
    ceilings = dict(files=max_files, bytes=max_bytes, entries=max_entries, rows=max_findings)
    root_partial = False
    stats = result['stats']
    accepted_rows = accepted_signature_rows()
    accepted_cards = {(row['path'], row['hash']): row['raison'] for row in accepted_rows if row['type'] == 'card'}
    public_evidence = {row['path']: row['hash'] for row in accepted_rows if row['type'] == 'public_fixture'}
    public_files = {}
    def partial():
        nonlocal root_partial
        root_partial = True
        result['state'] = 'partial'
    def exhausted():
        return (time.monotonic() >= deadline or stats['files'] >= ceilings['files'] or stats['bytes'] >= ceilings['bytes'] or stats['entries'] >= ceilings['entries'] or len(result['findings']) + len(result['warnings']) + len(result['accepted']) >= ceilings['rows'])
    def append(kind, value, path, line, warning=False):
        if len(result['findings']) + len(result['warnings']) + len(result['accepted']) >= ceilings['rows']:
            partial(); return
        digest = hashlib.sha256(value.encode()).hexdigest()[:16]
        row = {'path': path, 'line': line, 'type': kind, 'hash': digest}
        reason = accepted_cards.get((path, digest)) if kind == 'card' and path in attested_files else None
        if reason:
            row['raison'] = reason
            result['accepted'].append(row)
        else:
            result['warnings' if warning else 'findings'].append(row)
    attested_files = set()
    def visit(fd, prefix, depth=0):
        if depth > 24: partial(); return
        # scandir streams entries; it never materializes a large directory.
        with os.scandir(fd) as entries:
            for entry in entries:
                if exhausted(): partial(); break
                stats['entries'] += 1
                name = entry.name
                if name in EXCLUDED or PRIVATE_NAME.search(name) or any(ord(c) < 32 for c in name):
                    stats['skipped'] += 1; continue
                relative = prefix + '/' + safe_name(name)
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        try: visit(child, relative, depth+1)
                        finally: os.close(child)
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                        if is_binary_name(name):
                            stats['skipped'] += 1; stats['binary'] += 1; continue
                        child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                        try:
                            current = os.fstat(child)
                            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1: partial(); continue
                            if relative in public_files:
                                # Verify the entire file before any accepted signature can apply.
                                if current.st_size > min(file_bytes, ceilings['bytes']-stats['bytes']):
                                    partial(); continue
                                digest = hashlib.sha256()
                                remaining = current.st_size
                                while remaining:
                                    if time.monotonic() >= deadline:
                                        partial(); break
                                    block = os.read(child, min(BLOCK, remaining))
                                    stats['bytes'] += len(block)
                                    remaining -= len(block)
                                    if not block:
                                        break
                                    digest.update(block)
                                latest = os.fstat(child)
                                if (remaining == 0 and latest.st_size == current.st_size
                                        and latest.st_mtime_ns == current.st_mtime_ns
                                        and digest.hexdigest() == public_files[relative]):
                                    attested_files.add(relative)
                                os.lseek(child, 0, os.SEEK_SET)
                            allowance = min(file_bytes, ceilings['bytes']-stats['bytes'])
                            stats['files'] += 1
                            segments = iter_segments(child, allowance, deadline)
                            outcome, read = None, 0
                            while True:
                                try: number, line, offset, accept_before = next(segments)
                                except StopIteration as done:
                                    outcome, read = done.value; break
                                if len(result['findings']) + len(result['warnings']) + len(result['accepted']) >= ceilings['rows']:
                                    outcome, read = 'findings', allowance; break
                                for kind, pattern in [('token', TOKEN), ('private_key', PRIVATE), ('jwt', JWT), ('otp', OTP), ('card', CARD), ('email', EMAIL)]:
                                    for match in pattern.finditer(line):
                                        # Overlapping slices: the next slice owns matches starting in the overlap.
                                        if accept_before is not None and offset + match.start() >= accept_before:
                                            continue
                                        value = match.group(1) if kind == 'otp' else match.group()
                                        # API field names alone are not secret values in source code.
                                        if kind == 'token' and value.lower() in {'access_token', 'refresh_token'}:
                                            continue
                                        if kind != 'card' or card_candidate(value): append(kind, value, relative, number, kind == 'email')
                            stats['bytes'] += read
                            if outcome == 'binary':
                                stats['skipped'] += 1; stats['binary'] += 1
                            elif outcome in ('time', 'findings') or current.st_size > allowance:
                                partial()
                        finally: os.close(child)
                    else: stats['skipped'] += 1
                except OSError: partial()
    # Each root receives a share of the remaining budget inside the same job.
    # Unused shares flow forward; no persistent cursor, worker or multiplied cap.
    for index, (label, path) in enumerate(roots):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', label): raise ValueError('invalid_root_label')
        started = time.monotonic()
        remaining_roots = len(roots) - index
        before = dict(stats)
        row_count = len(result['findings']) + len(result['warnings']) + len(result['accepted'])
        root_partial = False
        budget = max(0, global_deadline - started) / remaining_roots
        deadline = min(global_deadline, started + budget)
        for key, maximum in [('files', max_files), ('bytes', max_bytes), ('entries', max_entries)]:
            ceilings[key] = stats[key] + max(0, maximum - stats[key]) // remaining_roots
        ceilings['rows'] = row_count + max(0, max_findings - row_count) // remaining_roots
        if exhausted() or any(part in EXCLUDED or PRIVATE_NAME.search(part) for part in Path(path).parts):
            partial()
        else:
            try: fd = open_root(path)
            except OSError: partial()
            else:
                repository = Path(__file__).resolve().parents[2]
                public_anchors = {'core': repository, 'core_installer': repository / 'installer', 'core_plugin': repository / 'openclaw-plugin-mobile-ui'}
                public_files = public_evidence if label in public_anchors and Path(path).absolute() == public_anchors[label] else {}
                attested_files.clear()
                try: visit(fd, safe_name(label))
                finally: os.close(fd)
        result['roots'].append({
            'label': safe_name(label), 'state': 'partial' if root_partial else 'ok',
            'budgetMs': int(budget * 1000),
            'durationMs': int(max(0, time.monotonic() - started) * 1000),
            'stats': {key: stats[key] - before[key] for key in before},
        })
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', action='append', required=True, metavar='LABEL=ABSOLUTE_PATH')
    for name, maximum in [('files', 10000), ('bytes', 64*1024*1024), ('entries', 20000), ('findings', 1000)]:
        parser.add_argument('--max-' + name, type=int, default=maximum)
    parser.add_argument('--seconds', type=float, default=10)
    args = parser.parse_args()
    if not 0 <= args.seconds <= 10 or any(not 0 <= getattr(args, 'max_' + name) <= maximum for name, maximum in [('files',10000),('bytes',64*1024*1024),('entries',20000),('findings',1000)]):
        parser.error('invalid scanner budget')
    roots = []
    for row in args.root:
        label, sep, path = row.partition('=')
        if not sep or not Path(path).is_absolute(): parser.error('root requires LABEL=ABSOLUTE_PATH')
        roots.append((label, path))
    try: result = scan_roots(roots, max_files=args.max_files, max_bytes=args.max_bytes, max_entries=args.max_entries, max_findings=args.max_findings, seconds=args.seconds)
    except ValueError: parser.error('invalid root label')
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
    return 1 if result['findings'] else 2 if result['state'] == 'partial' else 0

if __name__ == '__main__':
    raise SystemExit(main())
