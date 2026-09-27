#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
ROOT = HOME / "ClawMobile" / "installer" / "termux-lite"
BASE = HOME / ".openclaw" / "incidents"
INBOX = BASE / "ingress"
PROCESSED = BASE / "ingress-processed"
REJECTED = BASE / "ingress-rejected"
ORCH = ROOT / "incident-orchestrator.py"

SAFE = re.compile(r"^[A-Za-z0-9._-]{1,96}$")

def ensure_dirs():
    for p in (INBOX, PROCESSED, REJECTED):
        p.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass

def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, timeout=20, check=False)

def reject(path: Path, reason: str):
    stamp = str(int(time.time() * 1000))
    target = REJECTED / f"{path.stem}-{stamp}.json"
    shutil.move(str(path), str(target))
    (target.with_suffix(".reason")).write_text(reason[:500] + "\n")

def process(path: Path):
    try:
        row = json.loads(path.read_text())
    except Exception as e:
        reject(path, f"invalid_json:{e}")
        return

    component = str(row.get("component") or "").strip()
    scope = str(row.get("scope") or "runtime").strip()
    source = str(row.get("source") or "chatgpt-remote-ingress").strip()
    summary = str(row.get("summary") or "").strip()
    kind = str(row.get("kind") or "foreground_blocker").strip()
    evidence = row.get("evidence") or {}
    diagnose = bool(row.get("diagnose", True))

    if not SAFE.fullmatch(component):
        reject(path, "invalid_component")
        return
    if not SAFE.fullmatch(scope):
        reject(path, "invalid_scope")
        return
    if not SAFE.fullmatch(source):
        reject(path, "invalid_source")
        return
    if not SAFE.fullmatch(kind):
        reject(path, "invalid_kind")
        return
    if not summary or len(summary) > 1000:
        reject(path, "invalid_summary")
        return
    if not isinstance(evidence, dict):
        reject(path, "invalid_evidence")
        return

    opened = run(
        sys.executable, str(ORCH), "open", component, scope,
        "--source", source, "--summary", summary
    )
    if opened.returncode != 0:
        reject(path, "orchestrator_open_failed:" + opened.stderr[-300:])
        return
    try:
        incident = json.loads(opened.stdout)
        iid = incident["id"]
    except Exception as e:
        reject(path, f"orchestrator_output_invalid:{e}")
        return

    payload = {
        "ingress_file": path.name,
        "layer": row.get("layer", ""),
        "evidence": evidence,
    }
    obs = run(
        sys.executable, str(ORCH), "observe", iid, kind,
        "--source", source, "--json", json.dumps(payload, ensure_ascii=False)
    )
    if obs.returncode != 0:
        reject(path, "orchestrator_observe_failed:" + obs.stderr[-300:])
        return

    if diagnose:
        run(
            sys.executable, str(ORCH), "transition", iid, "diagnosing",
            "--source", source, "--reason", "foreground blocker delegated through non-shell ingress"
        )
    else:
        reason = str(row.get("terminal_reason") or "external or non-local boundary recorded; local repair intentionally not attempted")
        run(
            sys.executable, str(ORCH), "transition", iid, "failed",
            "--source", source, "--reason", reason[:1000]
        )

    out = dict(row)
    out.update({"incident_id": iid, "processed_at": time.time()})
    target = PROCESSED / path.name
    target.write_text(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    path.unlink(missing_ok=True)

def main():
    ensure_dirs()
    files = sorted(INBOX.glob("*.json"))
    for path in files[:50]:
        process(path)

if __name__ == "__main__":
    main()
