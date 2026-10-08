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
STATIC_BAD = ("{", "}", "$(", "`", ";", "&&", "||", "|", ">", "<")
SAFE_EXECUTION_STATES = {"completed"}
ASSISTED_EXECUTION_STATES = {
    "native_handoff",
    "delegation_required",
    "route_not_directly_executable",
    "runtime_not_directly_executable",
    "unsupported_runtime_input_mode",
    "low_confidence",
}


def _python_env(ui_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(ui_root) + (os.pathsep + existing if existing else "")
    return env


def _run_json(
    cmd: list[str],
    *,
    cwd: Path,
    timeout: int = 35,
    env: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any], str]:
    run = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    try:
        value = json.loads(run.stdout or "{}")
    except ValueError as exc:
        raise RuntimeError("invalid_json_result") from exc
    if not isinstance(value, dict):
        raise RuntimeError("expected_json_object")
    return run.returncode, value, (run.stderr or "").strip()


def _graph_cmd(
    action: str,
    message: str,
    *,
    ui_root: Path,
    surface: str,
    caller: str,
    timeout: int = 30,
) -> tuple[int, dict[str, Any], str]:
    args = [
        sys.executable,
        "-m",
        "skill_intelligence.capability_graph",
        action,
        message,
        "--surface",
        surface,
        "--caller",
        caller,
    ]
    if action == "execute":
        args.extend(["--timeout", str(timeout)])
    return _run_json(
        args,
        cwd=ui_root,
        timeout=timeout + 5,
        env=_python_env(ui_root),
    )


def resolve_capability(
    message: str,
    ui_root: Path = UI_ROOT,
    *,
    surface: str = "claw_live",
    caller: str = "owner",
) -> dict[str, Any]:
    rc, value, _ = _graph_cmd(
        "resolve",
        message,
        ui_root=ui_root,
        surface=surface,
        caller=caller,
        timeout=12,
    )
    if rc:
        raise RuntimeError("capability_resolve_failed")
    return value


def capability_first_eligibility(value: dict[str, Any]) -> tuple[str, str]:
    harness = value.get("harness") if isinstance(value.get("harness"), dict) else {}
    selected = value.get("selected") if isinstance(value.get("selected"), dict) else None
    if harness.get("tool_policy") != "required":
        return "miss", str(harness.get("reason") or "model_allowed")
    if not selected:
        return "assist", "required_but_unresolved"
    if selected.get("state") != "ready":
        return "assist", "selected_not_ready"
    if selected.get("authorized") is not True:
        return "known_error", "selected_not_authorized"
    if selected.get("deterministic") is not True:
        return "assist", "selected_not_deterministic"
    if selected.get("model_required") is True:
        return "assist", "selected_requires_model"
    return "eligible", "capability_first"


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
        if value.get("state") == "needs_parameter":
            question = value.get("question")
            if isinstance(question, str) and question.strip():
                return question.strip()
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value).strip()


def _handoff_contract(resolution: dict[str, Any]) -> dict[str, Any] | None:
    selected = resolution.get("selected") if isinstance(resolution.get("selected"), dict) else {}
    contract = selected.get("execution_contract") if isinstance(selected.get("execution_contract"), dict) else {}
    value = contract.get("pre_model_handoff")
    return value if isinstance(value, dict) else None


def _execute_declared_handoff(
    resolution: dict[str, Any],
    message: str,
    *,
    ui_root: Path,
    surface: str,
    caller: str,
    origin_id: str,
    timeout: int,
) -> dict[str, Any]:
    handoff = _handoff_contract(resolution)
    if not handoff:
        return {
            "status": "assist",
            "reason": "confirmation_requires_assisted_handoff",
            "resolution": resolution,
        }
    if handoff.get("effect_before_boundary") not in (False, "none"):
        return {
            "status": "known_error",
            "reason": "unsafe_pre_model_handoff_contract",
            "text": "La capacité est connue mais son handoff avant confirmation n'est pas qualifié.",
            "resolution": resolution,
        }
    entrypoint = str(handoff.get("entrypoint") or "").strip()
    input_mode = str(handoff.get("input_mode") or "")
    if not entrypoint or any(mark in entrypoint for mark in STATIC_BAD):
        return {
            "status": "known_error",
            "reason": "invalid_pre_model_handoff_entrypoint",
            "text": "La capacité est connue mais son handoff local n'est pas exécutable.",
            "resolution": resolution,
        }
    try:
        argv = shlex.split(entrypoint)
    except ValueError:
        return {
            "status": "known_error",
            "reason": "invalid_pre_model_handoff_entrypoint",
            "text": "La capacité est connue mais son handoff local n'est pas exécutable.",
            "resolution": resolution,
        }
    if len(argv) < 3 or argv[0] not in {"python", "python3"} or argv[1] != "-m":
        return {
            "status": "known_error",
            "reason": "unsupported_pre_model_handoff_entrypoint",
            "text": "La capacité est connue mais son handoff local n'est pas exécutable.",
            "resolution": resolution,
        }
    if input_mode != "request_arg":
        return {
            "status": "known_error",
            "reason": "unsupported_pre_model_handoff_input",
            "text": "La capacité est connue mais son contrat d'entrée doit être corrigé.",
            "resolution": resolution,
        }

    selected = resolution.get("selected") or {}
    env = _python_env(ui_root)
    env.update(
        {
            "CLAW_SELECTED_CAPABILITY": str(selected.get("capability") or ""),
            "CLAW_SELECTED_TARGET": str(selected.get("target") or ""),
            "CLAW_SELECTED_INTENT": str(selected.get("intent") or ""),
            "CLAW_SELECTED_ROUTE": str(selected.get("route") or ""),
            "CLAW_REQUEST_SURFACE": surface,
            "CLAW_REQUEST_CALLER": caller,
            "CLAW_REQUEST_ORIGIN_ID": origin_id[:120] or "capability-first",
        }
    )
    argv[0] = sys.executable
    argv.append(message)
    rc, payload, stderr = _run_json(
        argv,
        cwd=ui_root,
        timeout=max(5, min(timeout, 45)),
        env=env,
    )
    if rc:
        return {
            "status": "known_error",
            "reason": "pre_model_handoff_failed",
            "text": "La capacité est connue mais le handoff local a échoué avant tout effet.",
            "result": payload,
            "stderr": stderr[:800],
            "resolution": resolution,
        }
    text = (
        "Confirmation ouverte dans Samantha."
        if payload.get("state") == "handoff_ready"
        else _display_text(payload)
    )
    return {
        "status": "hit",
        "source": "capability_handoff",
        "text": text or "Confirmation locale requise.",
        "result": payload,
        "target": selected.get("target"),
        "intent": selected.get("intent"),
        "route": selected.get("route"),
        "capability": selected.get("capability"),
        "human_boundary": handoff.get("boundary"),
        "model_bypassed": True,
    }


def execute_capability(
    message: str,
    ui_root: Path = UI_ROOT,
    *,
    surface: str = "claw_live",
    caller: str = "owner",
    timeout: int = 30,
) -> dict[str, Any]:
    _, value, stderr = _graph_cmd(
        "execute",
        message,
        ui_root=ui_root,
        surface=surface,
        caller=caller,
        timeout=timeout,
    )
    if stderr:
        value.setdefault("_runtime_warning", stderr[:800])
    return value


def try_fast_path(
    message: str,
    ui_root: Path = UI_ROOT,
    *,
    execute: bool = True,
    surface: str = "claw_live",
    caller: str = "owner",
    origin_id: str = "capability-first",
    timeout: int = 30,
) -> dict[str, Any]:
    try:
        resolution = resolve_capability(message, ui_root, surface=surface, caller=caller)
        decision, reason = capability_first_eligibility(resolution)
        if decision == "miss":
            return {"status": "miss", "reason": reason, "resolution": resolution}
        if decision == "assist":
            return {"status": "assist", "reason": reason, "resolution": resolution}
        if decision == "known_error":
            return {
                "status": "known_error",
                "reason": reason,
                "text": "Cette action existe dans Claw mais n'est pas autorisée pour ce demandeur.",
                "resolution": resolution,
            }
        if not execute:
            return {
                "status": "eligible",
                "reason": reason,
                "resolution": resolution,
                "model_bypassed": True,
            }

        if resolution.get("confirmation_required") is True:
            return _execute_declared_handoff(
                resolution,
                message,
                ui_root=ui_root,
                surface=surface,
                caller=caller,
                origin_id=origin_id,
                timeout=timeout,
            )

        executed = execute_capability(
            message,
            ui_root,
            surface=surface,
            caller=caller,
            timeout=timeout,
        )
        execution = executed.get("execution") if isinstance(executed.get("execution"), dict) else {}
        state = str(execution.get("state") or "")
        selected = executed.get("selected") if isinstance(executed.get("selected"), dict) else {}
        if state in SAFE_EXECUTION_STATES:
            payload = execution.get("result")
            return {
                "status": "hit",
                "source": "capability",
                "text": _display_text(payload),
                "result": payload,
                "target": selected.get("target"),
                "intent": selected.get("intent"),
                "route": selected.get("route"),
                "capability": selected.get("capability"),
                "execution_state": state,
                "model_bypassed": True,
            }
        if state in ASSISTED_EXECUTION_STATES:
            return {
                "status": "assist",
                "reason": state,
                "resolution": executed,
            }
        if state == "confirmation_required":
            return _execute_declared_handoff(
                executed,
                message,
                ui_root=ui_root,
                surface=surface,
                caller=caller,
                origin_id=origin_id,
                timeout=timeout,
            )
        return {
            "status": "known_error",
            "reason": state or "known_execution_failed",
            "text": "Claw a identifié la capacité mais son exécution n'a pas atteint un état terminal vérifié.",
            "resolution": executed,
        }
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        return {
            "status": "error",
            "reason": type(exc).__name__,
            "detail": str(exc)[:800],
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Capability-first pre-model Claw ingress.")
    parser.add_argument("--check", action="store_true", help="Resolve only; do not execute or open a human boundary.")
    parser.add_argument("--ui-root", type=Path, default=UI_ROOT)
    parser.add_argument("--surface", default="claw_live")
    parser.add_argument("--caller", choices=("owner", "trusted", "other"), default="owner")
    parser.add_argument("--origin-id", default="capability-first")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("message", nargs="*")
    args = parser.parse_args()
    message = " ".join(args.message).strip()
    if not message and not sys.stdin.isatty():
        message = sys.stdin.read().strip()
    if not message:
        raise SystemExit("message_required")
    result = try_fast_path(
        message,
        args.ui_root,
        execute=not args.check,
        surface=args.surface,
        caller=args.caller,
        origin_id=args.origin_id,
        timeout=max(2, min(args.timeout, 120)),
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") in {"hit", "eligible", "miss", "assist", "known_error"} else 75


if __name__ == "__main__":
    raise SystemExit(main())
