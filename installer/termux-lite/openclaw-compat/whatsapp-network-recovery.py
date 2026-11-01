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

def package_version(root):
    return json.loads((root / "package.json").read_text()).get("version")

def variant(manifest, roots):
    """The pinned file set of the installed OpenClaw version.

    `package_version` + `files` stay the original pinned set. An optional
    `packages: {"<openclaw version>": {"files": [...], "root_versions": {...}}}` adds other versions, so one
    checkout owns the same patch before, during and after an OpenClaw upgrade or its rollback. Every other root
    must carry its `root_versions` entry, or the OpenClaw version itself."""
    extra = manifest.get("packages") or {}
    if extra:
        installed = package_version(roots["openclaw"])
        chosen = extra.get(installed)
        if chosen is not None:
            return chosen["files"], {name: chosen.get("root_versions", {}).get(name, installed) for name in roots}
    return manifest["files"], {name: manifest["package_version"] for name in roots}

def reconcile(roots, mode, manifest_path=None):
    manifest = json.loads((manifest_path or MANIFEST).read_text())
    files, _ = variant(manifest, roots)
    # Validate the entire set before the first write, including partially applied sets.
    planned = []
    for entry in files:
        path = roots[entry["root"]] / entry["path"]
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(roots[entry["root"]].resolve()):
            raise ValueError("patch_module_path_invalid:" + entry["path"])
        data = path.read_bytes()
        current = digest(data)
        predecessors = entry.get("predecessors", [])
        known = next((item for item in predecessors if item.get("patched") == current), None)
        if current not in (entry["original"], entry["patched"]) and known is None:
            raise ValueError("unsupported_module_hash:" + entry["path"])
        target_hash = entry["original"] if mode == "rollback" else entry["patched"]
        if current != target_hash:
            # Upgrade only a pinned predecessor, through its verified original bytes. The whole set is
            # validated before the first write; unknown state still refuses atomically.
            original = transform(data, {**entry, **known}, True) if known else None
            result = original if known and mode == "rollback" else transform(original if known else data, entry, mode == "rollback")
            planned.append((path, data, result))
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
    ap.add_argument("--patch-set", choices=("whatsapp-network-recovery", "agent-exec-auth-scope", "native-turn-provenance", "model-flow-selection", "gateway-prep-stages", "memory-retrieval-warm", "android-fs-compat", "startup-triage-optout"), default="whatsapp-network-recovery")
    args = ap.parse_args()
    try:
        manifest_path = MANIFEST.with_name(args.patch_set + ".json")
        manifest = json.loads(manifest_path.read_text())
        files, _ = variant(manifest, {"openclaw": args.openclaw_root.resolve()})
        needs_whatsapp = any(entry["root"] == "whatsapp" for entry in files)
        wa = args.whatsapp_root
        if needs_whatsapp and wa is None:
            state = Path(os.environ.get("OPENCLAW_STATE_DIR", str(Path.home() / ".openclaw")))
            candidates = list((state / "npm/projects").glob("*/node_modules/@openclaw/whatsapp"))
            if len(candidates) != 1:
                raise ValueError("whatsapp_package_missing_or_ambiguous")
            wa = candidates[0]
        roots = {"openclaw": args.openclaw_root.resolve()}
        if needs_whatsapp:
            roots["whatsapp"] = wa.resolve()
        _, expected = variant(manifest, roots)
        for name, root in roots.items():
            if package_version(root) != expected[name]:
                raise ValueError("unsupported_package_version")
        if args.mode == "check":
            result = reconcile(roots, args.mode, manifest_path)
        else:
            # One patch transaction, never a scheduler or runtime retry owner.
            with (roots["openclaw"] / ".samantha-wa-recovery.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                result = reconcile(roots, args.mode, manifest_path)
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "state": "refused", "reason": str(error)}))
        return 1

if __name__ == "__main__":
    sys.exit(main())
