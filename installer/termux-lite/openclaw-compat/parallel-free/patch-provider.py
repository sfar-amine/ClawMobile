#!/usr/bin/env python3
"""Explicit integrator operation, never called by the request adapter.

Only the exact, already installed official 2026.9.6 package is supported.
Default is a read-only check; --apply/--restore each modify one known file.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
PIN = json.loads((HERE / 'pin.json').read_text())


def state(root):
    hashes = {}
    for name in PIN['originalFiles']:
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise ValueError('plugin_files_invalid')
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if hashes == PIN['originalFiles']:
        return 'original'
    if hashes == PIN['hardenedFiles']:
        return 'hardened'
    raise ValueError('plugin_integrity_mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugin-dir', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--restore', action='store_true')
    args = parser.parse_args()
    root = args.plugin_dir.resolve(strict=True)
    patch = HERE / 'parallel-free-2026.9.6.patch'
    if hashlib.sha256(patch.read_bytes()).hexdigest() != PIN['patchSha256']:
        raise ValueError('patch_integrity_mismatch')
    before = state(root)
    desired = 'hardened' if args.apply else 'original' if args.restore else before
    if desired != before:
        command = ['patch', '--batch', '--forward', '-p1', '--input', str(patch)]
        if args.restore:
            command.append('--reverse')
        checked = subprocess.run(command + ['--dry-run'], cwd=root, capture_output=True)
        if checked.returncode:
            raise ValueError('patch_preflight_failed')
        applied = subprocess.run(command, cwd=root, capture_output=True)
        if applied.returncode:
            raise ValueError('patch_apply_failed')
        if state(root) != desired:
            raise ValueError('patch_postcondition_failed')
    print(json.dumps({'version': 1, 'package': PIN['package'], 'packageVersion': PIN['version'],
                      'before': before, 'after': desired, 'changed': before != desired}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        # Filesystem paths, command stderr and package contents are never exposed.
        code = str(error) if isinstance(error, ValueError) and str(error).startswith(('plugin_', 'patch_')) else 'provider_patch_failed'
        print(json.dumps({'ok': False, 'code': code}))
        sys.exit(1)
