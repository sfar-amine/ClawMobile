#!/usr/bin/env python3
"""Pinned, reversible compatibility patch; never edits credentials or running captures."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

MANIFEST = Path(__file__).with_suffix(".json")

def digest(data):
    return hashlib.sha256(data).hexdigest()

def transform(data, entry, reverse=False):
    text = data.decode()
    pairs = reversed(entry["replacements"]) if reverse else entry["replacements"]
    for before, after in pairs:
        if reverse:
            before, after = after, before
        if text.count(before) != 1:
            raise ValueError("patch_anchor_mismatch:" + entry["path"])
        text = text.replace(before, after)
    result = text.encode()
    if digest(result) != entry["original" if reverse else "patched"]:
        raise ValueError("patch_result_hash_mismatch:" + entry["path"])
    return result

def atomic_write(path, data):
    fd, name = tempfile.mkstemp(prefix=".wa-recovery-", dir=path.parent)
    try:
        os.fchmod(fd, path.stat().st_mode & 0o777)
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def reconcile(roots, mode):
    manifest = json.loads(MANIFEST.read_text())
    # Validate the entire set before the first write, including partially applied sets.
    planned = []
    for entry in manifest["files"]:
        path = roots[entry["root"]] / entry["path"]
        data = path.read_bytes()
        current = digest(data)
        if current not in (entry["original"], entry["patched"]):
            raise ValueError("unsupported_module_hash:" + entry["path"])
        target_hash = entry["original"] if mode == "rollback" else entry["patched"]
        if current != target_hash:
            planned.append((path, data, transform(data, entry, mode == "rollback")))
    if mode == "check":
        return {"ok": not planned, "state": "drift" if planned else "verified", "changed": len(planned)}
    written = []
    try:
        for path, old, new in planned:
            atomic_write(path, new)
            written.append((path, old))
    except BaseException:
        for path, old in reversed(written):
            atomic_write(path, old)
        raise
    return {"ok": True, "state": ("rolled_back" if mode == "rollback" else "applied") if planned else "unchanged", "changed": len(planned)}

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    group = ap.add_mutually_exclusive_group(required=True)
    for mode in ("check", "apply", "rollback"):
        group.add_argument("--" + mode, dest="mode", action="store_const", const=mode)
    ap.add_argument("--openclaw-root", type=Path, default=Path(os.environ.get("PREFIX", "/data/data/com.termux/files/usr")) / "lib/node_modules/openclaw")
    ap.add_argument("--whatsapp-root", type=Path)
    args = ap.parse_args()
    try:
        wa = args.whatsapp_root
        if wa is None:
            state = Path(os.environ.get("OPENCLAW_STATE_DIR", str(Path.home() / ".openclaw")))
            candidates = list((state / "npm/projects").glob("*/node_modules/@openclaw/whatsapp"))
            if len(candidates) != 1:
                raise ValueError("whatsapp_package_missing_or_ambiguous")
            wa = candidates[0]
        roots = {"openclaw": args.openclaw_root.resolve(), "whatsapp": wa.resolve()}
        expected = json.loads(MANIFEST.read_text())["package_version"]
        for root in roots.values():
            if json.loads((root / "package.json").read_text()).get("version") != expected:
                raise ValueError("unsupported_package_version")
        if args.mode == "check":
            result = reconcile(roots, args.mode)
        else:
            # One patch transaction, never a scheduler or runtime retry owner.
            with (roots["openclaw"] / ".samantha-wa-recovery.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                result = reconcile(roots, args.mode)
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "state": "refused", "reason": str(error)}))
        return 1

if __name__ == "__main__":
    sys.exit(main())
