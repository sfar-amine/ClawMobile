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


# Only committed public source paths can relax a private-looking basename.
PUBLIC_FIXTURE_PATHS = frozenset({'core/installer/termux-lite/test-workspace-secret-scan.py'})


def accepted_signature_rows():
    # Immutable repository evidence only; no runtime configuration or persistent store.
    path = Path(__file__).with_name('workspace-secret-scan-fixtures.json')
    try:
        if path.stat().st_size > 128 * 1024:
            return ()
        rows = json.loads(path.read_text())
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
    result = {'schemaVersion': 1, 'state': 'ok', 'findings': [], 'warnings': [], 'accepted': [], 'stats': {'files': 0, 'bytes': 0, 'entries': 0, 'skipped': 0, 'binary': 0}}
    deadline = time.monotonic() + seconds
    stats = result['stats']
    accepted_rows = accepted_signature_rows()
    accepted_cards = {(row['path'], row['hash']): row['raison'] for row in accepted_rows if row['type'] == 'card'}
    public_evidence = {row['path']: row['hash'] for row in accepted_rows if row['type'] == 'public_fixture'}
    public_files = {}
    def partial(): result['state'] = 'partial'
    def exhausted():
        return (time.monotonic() >= deadline or stats['files'] >= max_files or stats['bytes'] >= max_bytes or stats['entries'] >= max_entries or len(result['findings']) + len(result['warnings']) + len(result['accepted']) >= max_findings)
    def append(kind, value, path, line, warning=False):
        if len(result['findings']) + len(result['warnings']) + len(result['accepted']) >= max_findings:
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
                if name in EXCLUDED or any(ord(c) < 32 for c in name):
                    stats['skipped'] += 1; continue
                relative = prefix + '/' + safe_name(name)
                private_name = bool(PRIVATE_NAME.search(name))
                if private_name and relative not in public_files:
                    stats['skipped'] += 1; continue
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        if private_name:
                            stats['skipped'] += 1; continue
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
                                if current.st_size > min(file_bytes, max_bytes-stats['bytes']):
                                    partial(); continue
                                digest = hashlib.sha256()
                                while True:
                                    if time.monotonic() >= deadline:
                                        partial(); break
                                    block = os.read(child, BLOCK)
                                    stats['bytes'] += len(block)
                                    if not block:
                                        if digest.hexdigest() == public_files[relative]:
                                            attested_files.add(relative)
                                        break
                                    digest.update(block)
                                os.lseek(child, 0, os.SEEK_SET)
                            if private_name and relative not in attested_files:
                                stats['skipped'] += 1; continue
                            allowance = min(file_bytes, max_bytes-stats['bytes'])
                            stats['files'] += 1
                            segments = iter_segments(child, allowance, deadline)
                            outcome, read = None, 0
                            while True:
                                try: number, line, offset, accept_before = next(segments)
                                except StopIteration as done:
                                    outcome, read = done.value; break
                                if len(result['findings']) + len(result['warnings']) + len(result['accepted']) >= max_findings:
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
    for label, path in roots:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', label): raise ValueError('invalid_root_label')
        if exhausted(): partial(); break
        try: fd = open_root(path)
        except OSError: partial(); continue
        public_files = public_evidence if label == 'core' and Path(path).absolute() == Path(__file__).resolve().parents[2] else {}
        attested_files.clear()
        try: visit(fd, safe_name(label))
        finally: os.close(fd)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', action='append', required=True, metavar='LABEL=ABSOLUTE_PATH')
    args = parser.parse_args()
    roots = []
    for row in args.root:
        label, sep, path = row.partition('=')
        if not sep or not Path(path).is_absolute(): parser.error('root requires LABEL=ABSOLUTE_PATH')
        roots.append((label, path))
    try: result = scan_roots(roots)
    except ValueError: parser.error('invalid root label')
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
    return 1 if result['findings'] else 2 if result['state'] == 'partial' else 0

if __name__ == '__main__':
    raise SystemExit(main())
