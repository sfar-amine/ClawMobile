#!/data/data/com.termux/files/usr/bin/python3
"""Install/check a bounded Gradle user configuration for Android builds on S24."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

BEGIN = "# CLAW_S24_ANDROID_BUILD_GUARD_V1_BEGIN"
END = "# CLAW_S24_ANDROID_BUILD_GUARD_V1_END"
VALUES = {
    "org.gradle.jvmargs": "-Xmx768m -XX:ActiveProcessorCount=2 -Dfile.encoding=UTF-8",
    "org.gradle.workers.max": "1",
    "org.gradle.daemon": "false",
    "org.gradle.parallel": "false",
}

def gradle_file(home: Path | None = None) -> Path:
    if home is not None:
        return Path(home) / ".gradle" / "gradle.properties"
    root = os.environ.get("GRADLE_USER_HOME")
    return Path(root) / "gradle.properties" if root else Path.home() / ".gradle" / "gradle.properties"

def state_file(home: Path | None = None) -> Path:
    root = Path(home or Path.home())
    return root / ".openclaw" / "build-guard" / "gradle.json"

def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()

def strip_block(text: str) -> tuple[str, str | None]:
    starts = [m.start() for m in re.finditer(re.escape(BEGIN), text)]
    ends = [m.start() for m in re.finditer(re.escape(END), text)]
    if not starts and not ends:
        return text, None
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
        raise RuntimeError("invalid_managed_block")
    start = starts[0]
    end = ends[0] + len(END)
    block = text[start:end]
    body = text[:start] + text[end:]
    return body, block

def active_keys(text: str) -> set[str]:
    keys = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "!")):
            continue
        if "=" in line:
            keys.add(line.split("=", 1)[0].strip())
        elif ":" in line:
            keys.add(line.split(":", 1)[0].strip())
    return keys

def block_text() -> str:
    rows = [BEGIN]
    rows += [f"{k}={v}" for k, v in VALUES.items()]
    rows.append(END)
    return "\n".join(rows) + "\n"

def parse_block(block: str | None) -> dict[str, str]:
    if not block:
        return {}
    out = {}
    for raw in block.splitlines():
        line = raw.strip()
        if not line or line in {BEGIN, END} or line.startswith(("#", "!")):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out

def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def apply(home: Path | None = None) -> dict:
    path = gradle_file(home)
    current = path.read_text() if path.exists() else ""
    body, _ = strip_block(current)
    conflicts = sorted(active_keys(body) & set(VALUES))
    if conflicts:
        raise RuntimeError("managed_key_conflict:" + ",".join(conflicts))
    body = body.rstrip()
    rendered = ((body + "\n\n") if body else "") + block_text()
    atomic_write(path, rendered)
    state = {
        "version": 1,
        "path": str(path),
        "managed_values": VALUES,
        "sha256": sha(rendered),
    }
    atomic_write(state_file(home), json.dumps(state, indent=2, sort_keys=True) + "\n")
    return {"state": "applied", **state}

def check(home: Path | None = None) -> dict:
    path = gradle_file(home)
    if not path.exists():
        return {"state": "missing", "path": str(path), "ok": False}
    text = path.read_text()
    try:
        body, block = strip_block(text)
    except RuntimeError as exc:
        return {"state": str(exc), "path": str(path), "ok": False}
    conflicts = sorted(active_keys(body) & set(VALUES))
    actual = parse_block(block)
    ok = not conflicts and actual == VALUES
    return {
        "state": "healthy" if ok else "drift",
        "path": str(path),
        "ok": ok,
        "managed_values": actual,
        "conflicts": conflicts,
        "sha256": sha(text),
    }

def remove(home: Path | None = None) -> dict:
    path = gradle_file(home)
    if not path.exists():
        return {"state": "absent", "path": str(path)}
    body, block = strip_block(path.read_text())
    if block is None:
        return {"state": "absent", "path": str(path)}
    remaining = body.strip()
    if remaining:
        atomic_write(path, remaining + "\n")
    else:
        path.unlink()
    try:
        state_file(home).unlink()
    except FileNotFoundError:
        pass
    return {"state": "removed", "path": str(path)}

def main() -> None:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--apply", action="store_true")
    action.add_argument("--check", action="store_true")
    action.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    try:
        result = apply() if args.apply else remove() if args.remove else check()
    except RuntimeError as exc:
        result = {"state": "refused", "ok": False, "reason": str(exc), "path": str(gradle_file())}
        print(json.dumps(result, sort_keys=True))
        raise SystemExit(2)
    print(json.dumps(result, sort_keys=True))
    if args.check and not result.get("ok"):
        raise SystemExit(2)

if __name__ == "__main__":
    main()
