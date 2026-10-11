#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

HOME = Path.home()
DEFAULT_UI = HOME / ".openclaw/workspace/ui-playbooks"
# Pinned runtime snapshot (activate-ui-playbooks.sh). Preferred over the mutable workspace so a core restart
# from a shell without CLAW_UI_PLAYBOOKS_ROOT never silently runs unreleased playbooks.
PINNED_UI = HOME / ".openclaw/runtime-ui-playbooks/current"


def ui_root() -> Path:
    configured = os.environ.get("CLAW_UI_PLAYBOOKS_ROOT")
    candidates = [
        Path(configured).expanduser() if configured else None,
        PINNED_UI,
        DEFAULT_UI,
    ]
    for path in candidates:
        if path and (path / "skill_intelligence/capability_graph.py").is_file():
            return path
    raise SystemExit("capability_graph_unavailable")


def _graph(args: list[str], timeout_s: int = 35, input_text: str | None = None) -> subprocess.CompletedProcess:
    root = ui_root()
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return subprocess.run(
        [sys.executable, "-m", "skill_intelligence.capability_graph", *args],
        cwd=root,
        env=env,
        timeout=max(2, min(timeout_s, 125)),
        text=True,
        capture_output=True,
        input=input_text,
    )


def call(args: list[str], timeout_s: int = 35, input_text: str | None = None) -> int:
    run = _graph(args, timeout_s, input_text)
    if run.stdout:
        sys.stdout.write(run.stdout)
    if run.stderr:
        sys.stderr.write(run.stderr)
    return run.returncode


# 38 E3: skill families whose targets are operators (manifest `family`, same notion as E1).
OPERATOR_FAMILIES = frozenset({"telecom_selfcare", "utility_billing"})


def _manifest_families(root: Path) -> dict[str, str]:
    families: dict[str, str] = {}
    for path in sorted((root / "skill_intelligence/manifests").glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("id"), str):
            families[data["id"]] = str(data.get("family") or "")
    return families


def agent_policy(resolution: dict, families: dict[str, str]) -> dict:
    """E3 policy over the canonical decision; it never selects or re-routes anything.

    The free agent may only execute a canonical EXECUTE decision whose risk is `read` and whose
    target is not an operator. Everything else is `capability_first_required`: the original text
    goes through the Companion fast path / owner confirmation instead.
    """
    decision = resolution.get("decision") if isinstance(resolution.get("decision"), dict) else {}
    selected = resolution.get("selected") if isinstance(resolution.get("selected"), dict) else {}
    clarification = decision.get("clarification") if isinstance(decision.get("clarification"), dict) else {}
    choices = [c for c in (clarification.get("choices") or []) if isinstance(c, dict)]
    risks = {str(decision.get("risk") or "read"), str(selected.get("risk") or "read")}
    risks.update(str(c.get("risk") or "read") for c in choices)
    targets = {str(x) for x in (decision.get("target"), selected.get("target")) if x}
    operator = sorted(t for t in targets if families.get(t) in OPERATOR_FAMILIES)
    decision_type = str(decision.get("type") or "")
    risk = "read" if risks == {"read"} else sorted(r for r in risks if r != "read")[0]
    allowed = bool(decision) and risk == "read" and not operator and not resolution.get("confirmation_required")
    return {
        "version": 1,
        "allowed": allowed,
        "reason": None if allowed else "capability_first_required",
        "decision_type": decision_type or None,
        "risk": risk,
        "operator_targets": operator,
    }


def agent_execute(text: str, surface: str, caller: str, timeout_s: int) -> int:
    """Resolve once, check the E3 policy, then execute exactly that decision in read-only mode."""
    resolved = _graph(["resolve", text, "--surface", surface, "--caller", caller], timeout_s=20)
    try:
        resolution = json.loads(resolved.stdout or "{}")
        if not isinstance(resolution, dict):
            raise ValueError("resolution_object_required")
    except ValueError:
        sys.stdout.write(json.dumps({"execution": {"state": "error", "reason": "capability_resolve_failed"}}))
        return 75
    policy = agent_policy(resolution, _manifest_families(ui_root()))
    decision = resolution.get("decision")
    if not policy["allowed"]:
        sys.stdout.write(json.dumps({
            "capability_revision": resolution.get("capability_revision"),
            "surface": surface, "caller": caller,
            "capability": resolution.get("capability"),
            "decision": decision,
            "agent_policy": policy,
            "execution": {"state": "blocked", "reason": "capability_first_required", "executed": False},
        }, ensure_ascii=False))
        return 0
    executed = _graph(
        ["execute-decision", text, "--decision-stdin", "--timeout", str(timeout_s), "--read-only"],
        timeout_s=timeout_s + 5, input_text=json.dumps(decision, ensure_ascii=False),
    )
    try:
        result = json.loads(executed.stdout or "{}")
        if not isinstance(result, dict):
            raise ValueError("result_object_required")
    except ValueError:
        sys.stdout.write(json.dumps({"execution": {"state": "error", "reason": "capability_execute_failed"}}))
        return 75
    result["agent_policy"] = policy
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    if executed.stderr:
        sys.stderr.write(executed.stderr)
    return executed.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Claw capability graph runtime adapter")
    sub = parser.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("resolve")
    r.add_argument("text")
    r.add_argument("--surface", default="chatgpt")
    r.add_argument("--caller", default="owner")
    r.add_argument("--target")
    r.add_argument("--request-id")

    e = sub.add_parser("execute")
    e.add_argument("text")
    e.add_argument("--surface", default="chatgpt")
    e.add_argument("--caller", default="owner")
    e.add_argument("--timeout", type=int, default=30)
    e.add_argument("--target")
    e.add_argument("--read-only", action="store_true")

    ae = sub.add_parser("agent-execute")
    ae.add_argument("text")
    ae.add_argument("--surface", default="chatgpt")
    ae.add_argument("--caller", default="other")
    ae.add_argument("--timeout", type=int, default=30)

    ed = sub.add_parser("execute-decision")
    ed.add_argument("text")
    ed.add_argument("--decision-b64", required=True)
    ed.add_argument("--timeout", type=int, default=30)
    ed.add_argument("--read-only", action="store_true")

    vd = sub.add_parser("validate-decision")
    vd.add_argument("text")
    vd.add_argument("--decision-b64", required=True)

    v = sub.add_parser("view")
    v.add_argument("--surface", default="chatgpt")
    v.add_argument("--caller", default="owner")
    v.add_argument("--compact", action="store_true")
    v.add_argument("--max-chars", type=int, default=3600)

    c = sub.add_parser("compile")
    c.add_argument("--output-dir", default=str(HOME / ".openclaw/capability-views"))

    args = parser.parse_args()
    if args.cmd == "resolve":
        forwarded = ["resolve", args.text, "--surface", args.surface, "--caller", args.caller]
        if args.target:
            forwarded.extend(["--target", args.target])
        if args.request_id:
            forwarded.extend(["--request-id", args.request_id])
        return call(forwarded)
    if args.cmd == "execute":
        forwarded = [
            "execute", args.text, "--surface", args.surface, "--caller", args.caller,
            "--timeout", str(args.timeout),
        ]
        if args.target:
            forwarded.extend(["--target", args.target])
        if args.read_only:
            forwarded.append("--read-only")
        return call(forwarded, timeout_s=args.timeout + 5)
    if args.cmd == "agent-execute":
        return agent_execute(args.text, args.surface, args.caller, max(2, min(args.timeout, 120)))
    if args.cmd == "execute-decision":
        try:
            raw = base64.b64decode(args.decision_b64.encode("ascii"), validate=True).decode("utf-8")
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("decision_object_required")
        except Exception:
            raise SystemExit("invalid_decision_b64")
        forwarded = ["execute-decision", args.text, "--decision-stdin", "--timeout", str(args.timeout)]
        if args.read_only:
            forwarded.append("--read-only")
        return call(forwarded, timeout_s=args.timeout + 5, input_text=json.dumps(parsed, ensure_ascii=False))
    if args.cmd == "validate-decision":
        try:
            raw = base64.b64decode(args.decision_b64.encode("ascii"), validate=True).decode("utf-8")
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("decision_object_required")
        except Exception:
            raise SystemExit("invalid_decision_b64")
        return call(["validate-decision", args.text, "--decision-stdin"], timeout_s=20, input_text=json.dumps(parsed, ensure_ascii=False))
    if args.cmd == "view":
        forwarded = ["view", "--surface", args.surface, "--caller", args.caller, "--max-chars", str(args.max_chars)]
        if args.compact:
            forwarded.append("--compact")
        return call(forwarded)
    return call(["compile", "--output-dir", args.output_dir])


if __name__ == "__main__":
    raise SystemExit(main())
