#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from typing import Any

HOME = Path.home()
UI_ROOT = HOME / ".openclaw/workspace/ui-playbooks"
MIN_CONFIDENCE = 0.95
SAFE_ROUTE_STATUSES = {"validated", "stable"}
SAFE_RISK = "read"
MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


def _run_json(cmd: list[str], *, cwd: Path, timeout: int = 12) -> dict[str, Any]:
    run = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if run.returncode:
        raise RuntimeError((run.stderr or run.stdout or "command_failed").strip()[:1200])
    value = json.loads(run.stdout or "{}")
    if not isinstance(value, dict):
        raise RuntimeError("expected_json_object")
    return value


def resolve_plan(message: str, ui_root: Path = UI_ROOT) -> dict[str, Any]:
    cmd = [sys.executable, "-m", "skill_intelligence.cli", "resolve", message]
    return _run_json(cmd, cwd=ui_root)


def _manifest_path(target: str, ui_root: Path) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "", target)
    if not safe or safe != target:
        raise RuntimeError("unsafe_target")
    return ui_root / "skill_intelligence" / "manifests" / f"{safe}.json"


def _route_from_manifest(plan: dict[str, Any], ui_root: Path) -> dict[str, Any] | None:
    target = str(plan.get("target") or "")
    raw_intent = plan.get("intent")
    intent_id = str(raw_intent if isinstance(raw_intent, str) else (raw_intent or {}).get("id") or "")
    raw_route = plan.get("route")
    route_id = str(raw_route if isinstance(raw_route, str) else (raw_route or {}).get("id") or "")
    if not target or not intent_id or not route_id:
        return None
    path = _manifest_path(target, ui_root)
    if not path.is_file():
        return None
    data = json.loads(path.read_text())
    intent = (data.get("intents") or {}).get(intent_id) or {}
    for route in intent.get("routes") or []:
        if str(route.get("id") or "") == route_id:
            return route
    return None


def eligible(plan: dict[str, Any], route: dict[str, Any] | None) -> tuple[bool, str]:
    if plan.get("mode") != "known":
        return False, "not_known"
    if float(plan.get("confidence") or 0) < MIN_CONFIDENCE:
        return False, "low_confidence"
    if str(plan.get("risk") or "") != SAFE_RISK:
        return False, "not_read_only"
    if plan.get("confirmation_required") is True:
        return False, "confirmation_required"
    if plan.get("fallback"):
        return False, "fallback_selected"
    raw_route = plan.get("route")
    route_id = str(raw_route if isinstance(raw_route, str) else (raw_route or {}).get("id") or "")
    route_health = plan.get("route_health") or {}
    health = str(route_health.get(route_id) or ((raw_route or {}).get("health") if isinstance(raw_route, dict) else "") or "")
    if health and health != "healthy":
        return False, "route_unhealthy"
    if not route:
        return False, "route_missing"
    if str(route.get("status") or "") not in SAFE_ROUTE_STATUSES:
        return False, "route_not_validated"
    if str(route.get("layer") or "") != "script":
        return False, "not_script_route"
    entrypoint = str(route.get("entrypoint") or "").strip()
    if not entrypoint:
        return False, "entrypoint_missing"
    if any(mark in entrypoint for mark in ("{", "}", "$(", "`", ";", "&&", "||", "|")):
        return False, "entrypoint_not_static"
    try:
        parts = shlex.split(entrypoint)
    except ValueError:
        return False, "entrypoint_invalid"
    if len(parts) < 3 or parts[0] not in {"python", "python3"} or parts[1] != "-m":
        return False, "entrypoint_not_python_module"
    if not MODULE_RE.fullmatch(parts[2]):
        return False, "module_invalid"
    return True, "eligible"


def _execute_route(route: dict[str, Any], ui_root: Path) -> tuple[int, str, str]:
    parts = shlex.split(str(route["entrypoint"]))
    parts[0] = sys.executable
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(ui_root) + (os.pathsep + existing if existing else "")
    run = subprocess.run(parts, cwd=ui_root, env=env, capture_output=True, text=True, timeout=20)
    return run.returncode, run.stdout.strip(), run.stderr.strip()


def _display_text(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("text", "message", "summary", "answer"):
            text = value.get(key)
            if isinstance(text, str) and text.strip():
                return text.strip()
        if value.get("state") == "needs_counter" and isinstance(value.get("choices"), list):
            choices = [str(x) for x in value["choices"] if str(x).strip()]
            if choices:
                return "Précise : " + " / ".join(choices)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value).strip()


def try_fast_path(message: str, ui_root: Path = UI_ROOT, *, execute: bool = True) -> dict[str, Any]:
    try:
        plan = resolve_plan(message, ui_root)
        route = _route_from_manifest(plan, ui_root)
        ok, reason = eligible(plan, route)
        if not ok:
            return {"status": "miss", "reason": reason, "plan": plan}
        if not execute:
            return {"status": "eligible", "reason": reason, "plan": plan, "route": route}
        rc, stdout, stderr = _execute_route(route or {}, ui_root)
        try:
            payload: Any = json.loads(stdout)
        except ValueError:
            payload = stdout

        bounded_nonzero = (
            rc != 0
            and isinstance(payload, dict)
            and payload.get("state") == "needs_counter"
            and payload.get("sent") is False
            and isinstance(payload.get("choices"), list)
        )
        if rc and not bounded_nonzero:
            return {"status": "error", "reason": "route_failed", "exit_code": rc, "stderr": stderr[:1200]}
        return {
            "status": "hit",
            "source": "deterministic",
            "text": _display_text(payload),
            "result": payload,
            "target": plan.get("target"),
            "intent": plan.get("intent") if isinstance(plan.get("intent"), str) else (plan.get("intent") or {}).get("id"),
            "route": plan.get("route") if isinstance(plan.get("route"), str) else (plan.get("route") or {}).get("id"),
        }
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        return {"status": "error", "reason": type(exc).__name__, "detail": str(exc)[:800]}


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve and execute bounded read-only Claw fast paths.")
    parser.add_argument("--check", action="store_true", help="Resolve only; do not execute the route.")
    parser.add_argument("--ui-root", type=Path, default=UI_ROOT)
    parser.add_argument("message", nargs="*")
    args = parser.parse_args()
    message = " ".join(args.message).strip()
    if not message and not sys.stdin.isatty():
        message = sys.stdin.read().strip()
    if not message:
        raise SystemExit("message_required")
    result = try_fast_path(message, args.ui_root, execute=not args.check)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") in {"hit", "eligible", "miss"} else 75


if __name__ == "__main__":
    raise SystemExit(main())
