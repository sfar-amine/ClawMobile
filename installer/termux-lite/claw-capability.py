#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

HOME = Path.home()
DEFAULT_UI = HOME / ".openclaw/workspace/ui-playbooks"


def ui_root() -> Path:
    configured = os.environ.get("CLAW_UI_PLAYBOOKS_ROOT")
    candidates = [
        Path(configured).expanduser() if configured else None,
        DEFAULT_UI,
    ]
    for path in candidates:
        if path and (path / "skill_intelligence/capability_graph.py").is_file():
            return path
    raise SystemExit("capability_graph_unavailable")


def call(args: list[str], timeout_s: int = 35) -> int:
    root = ui_root()
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    run = subprocess.run(
        [sys.executable, "-m", "skill_intelligence.capability_graph", *args],
        cwd=root,
        env=env,
        timeout=max(2, min(timeout_s, 125)),
        text=True,
        capture_output=True,
    )
    if run.stdout:
        sys.stdout.write(run.stdout)
    if run.stderr:
        sys.stderr.write(run.stderr)
    return run.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Claw capability graph runtime adapter")
    sub = parser.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("resolve")
    r.add_argument("text")
    r.add_argument("--surface", default="chatgpt")
    r.add_argument("--caller", default="owner")

    e = sub.add_parser("execute")
    e.add_argument("text")
    e.add_argument("--surface", default="chatgpt")
    e.add_argument("--caller", default="owner")
    e.add_argument("--timeout", type=int, default=30)

    v = sub.add_parser("view")
    v.add_argument("--surface", default="chatgpt")
    v.add_argument("--caller", default="owner")
    v.add_argument("--compact", action="store_true")
    v.add_argument("--max-chars", type=int, default=3600)

    c = sub.add_parser("compile")
    c.add_argument("--output-dir", default=str(HOME / ".openclaw/capability-views"))

    args = parser.parse_args()
    if args.cmd == "resolve":
        return call(["resolve", args.text, "--surface", args.surface, "--caller", args.caller])
    if args.cmd == "execute":
        return call([
            "execute", args.text, "--surface", args.surface, "--caller", args.caller,
            "--timeout", str(args.timeout),
        ], timeout_s=args.timeout + 5)
    if args.cmd == "view":
        forwarded = ["view", "--surface", args.surface, "--caller", args.caller, "--max-chars", str(args.max_chars)]
        if args.compact:
            forwarded.append("--compact")
        return call(forwarded)
    return call(["compile", "--output-dir", args.output_dir])


if __name__ == "__main__":
    raise SystemExit(main())
