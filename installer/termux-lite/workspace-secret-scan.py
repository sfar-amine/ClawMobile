#!/usr/bin/env python3
"""Bounded read-only diagnostics. Values never leave this process; no runtime defaults."""
import argparse
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
CARD = re.compile(r'(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)')
EMAIL = re.compile(r'\b[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')
EXCLUDED = {'.git', 'node_modules', 'context', 'context-backup', 'contacts', 'credentials', 'payments'}
PRIVATE_NAME = re.compile(r'(?i)(?:\.env(?:\.|$)|credential|secret|token|\.key$|\.pem$|^auth.*\.json$|payment|bank)')


def luhn(value):
    digits = [int(c) for c in value if c.isdigit()]
    if len(digits) < 13 or len(digits) > 19 or len(set(digits)) == 1:
        return False
    return sum((n * 2 - 9 if n > 4 else n * 2) if i % 2 == len(digits) % 2 else n for i, n in enumerate(digits)) % 10 == 0


def open_root(path):
    """Anchor every absolute path component, including parents, without following links."""
    path = Path(path).absolute()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def scan_roots(roots, *, max_files=10000, max_bytes=64*1024*1024, file_bytes=1024*1024, max_entries=20000, max_findings=1000, seconds=10):
    result = {'schemaVersion': 1, 'state': 'ok', 'findings': [], 'warnings': [], 'stats': {'files': 0, 'bytes': 0, 'entries': 0, 'skipped': 0}}
    deadline = time.monotonic() + seconds
    stats = result['stats']
    def partial(): result['state'] = 'partial'
    def exhausted():
        return (time.monotonic() >= deadline or stats['files'] >= max_files or stats['bytes'] >= max_bytes or stats['entries'] >= max_entries or len(result['findings']) + len(result['warnings']) >= max_findings)
    def append(kind, value, path, line, warning=False):
        if len(result['findings']) + len(result['warnings']) >= max_findings:
            partial(); return
        result['warnings' if warning else 'findings'].append({'path': path, 'line': line, 'type': kind, 'hash': hashlib.sha256(value.encode()).hexdigest()[:16]})
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
                relative = prefix + '/' + name
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        try: visit(child, relative, depth+1)
                        finally: os.close(child)
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                        child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                        try:
                            current = os.fstat(child)
                            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1: partial(); continue
                            allowance = min(file_bytes, max_bytes-stats['bytes'])
                            data = os.read(child, allowance)
                            stats['files'] += 1; stats['bytes'] += len(data)
                            if current.st_size > len(data): partial()
                        finally: os.close(child)
                        if b'\0' in data: continue
                        try: text = data.decode('utf-8')
                        except UnicodeError: partial(); continue
                        for number, line in enumerate(text.splitlines(), 1):
                            if time.monotonic() >= deadline or len(result['findings']) + len(result['warnings']) >= max_findings: partial(); break
                            for kind, pattern in [('token', TOKEN), ('private_key', PRIVATE), ('jwt', JWT), ('otp', OTP), ('card', CARD), ('email', EMAIL)]:
                                for match in pattern.finditer(line):
                                    value = match.group(1) if kind == 'otp' else match.group()
                                    if kind != 'card' or luhn(value): append(kind, value, relative, number, kind == 'email')
                    else: stats['skipped'] += 1
                except OSError: partial()
    for label, path in roots:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', label): raise ValueError('invalid_root_label')
        if exhausted(): partial(); break
        try: fd = open_root(path)
        except OSError: partial(); continue
        try: visit(fd, label)
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
