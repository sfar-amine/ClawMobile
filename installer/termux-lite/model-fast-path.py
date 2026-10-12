#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from typing import Any

HOME = Path.home()
def _ui_root() -> Path:
    # Same order as claw-capability.py: explicit root, pinned runtime snapshot, then the mutable workspace.
    configured = os.environ.get("CLAW_UI_PLAYBOOKS_ROOT")
    if configured:
        return Path(configured).expanduser()
    pinned = HOME / ".openclaw/runtime-ui-playbooks/current"
    if (pinned / "skill_intelligence/capability_graph.py").is_file():
        return pinned
    return HOME / ".openclaw/workspace/ui-playbooks"
UI_ROOT = _ui_root()
STATIC_BAD = ("{", "}", "$(", "`", ";", "&&", "||", "|", ">", "<")
SAFE_EXECUTION_STATES = {"completed"}
HIGH_CONSEQUENCE_RISKS = {"transaction", "destructive", "sensitive", "external_send"}
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


# O6 (fichier 37, décision du 11/10/2026) : une consultation opérateur gardée tient en 60 s au total
# (borne du garde réseau, CONSULTATION_TOTAL_S d'android-network-mutation-guard.py). Le fast path l'attend
# avec marge et n'abandonne jamais pendant que le garde tient le Wi-Fi coupé.
GUARDED_OPERATOR_ENTRYPOINTS = ("python -m telecom.maxit_guarded_service ",)
GUARDED_ENTRY_TOTAL_S = 60
GUARDED_ENTRY_WAIT_S = 70


def guarded_execution_timeout(timeout: int, *selections: Any) -> int:
    """Execution wait for the selected route: at least the guarded total plus margin for a guarded entry."""
    for selected in selections:
        entrypoint = str(selected.get("entrypoint") or "") if isinstance(selected, dict) else ""
        if entrypoint.startswith(GUARDED_OPERATOR_ENTRYPOINTS):
            return min(120, max(int(timeout), GUARDED_ENTRY_WAIT_S))
    return timeout


def _run_json(
    cmd: list[str],
    *,
    cwd: Path,
    timeout: int = 35,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
) -> tuple[int, dict[str, Any], str]:
    run = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        input=input_text,
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
    request_id: str | None = None,
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
    if action == "resolve" and request_id:
        args.extend(["--request-id", str(request_id)[:160]])
    return _run_json(
        args,
        cwd=ui_root,
        timeout=timeout + 5,
        env=_python_env(ui_root),
    )


def _graph_decision_cmd(
    action: str,
    message: str,
    decision: dict[str, Any],
    *,
    ui_root: Path,
    timeout: int = 30,
    read_only: bool = False,
) -> tuple[int, dict[str, Any], str]:
    if action not in {"validate-decision", "execute-decision"}:
        raise ValueError("invalid_decision_action")
    args = [sys.executable, "-m", "skill_intelligence.capability_graph", action, message, "--decision-stdin"]
    if action == "execute-decision":
        args.extend(["--timeout", str(timeout)])
        if read_only:
            args.append("--read-only")
    return _run_json(
        args, cwd=ui_root, timeout=timeout + 5, env=_python_env(ui_root),
        input_text=json.dumps(decision, ensure_ascii=False, separators=(",", ":")),
    )


def validate_prepared_decision(
    message: str, decision: dict[str, Any], ui_root: Path = UI_ROOT, *, timeout: int = 15,
) -> dict[str, Any]:
    rc, value, _ = _graph_decision_cmd(
        "validate-decision", message, decision, ui_root=ui_root, timeout=timeout,
    )
    if rc:
        raise RuntimeError("decision_validation_failed")
    return value


def execute_capability_decision(
    message: str, decision: dict[str, Any], ui_root: Path = UI_ROOT, *, timeout: int = 30,
    read_only: bool = False,
) -> dict[str, Any]:
    _, value, stderr = _graph_decision_cmd(
        "execute-decision", message, decision, ui_root=ui_root, timeout=timeout, read_only=read_only,
    )
    if stderr:
        value.setdefault("_runtime_warning", stderr[:800])
    return value


def resolve_clarification(
    answer: str, original_text: str, decision: dict[str, Any], ui_root: Path = UI_ROOT, *,
    request_id: str | None = None, timeout: int = 15,
) -> dict[str, Any]:
    args = [
        sys.executable, "-m", "skill_intelligence.capability_graph",
        "resolve-clarification", answer, "--original-text", original_text, "--decision-stdin",
    ]
    if request_id:
        args.extend(["--request-id", str(request_id)[:160]])
    rc, value, _ = _run_json(
        args, cwd=ui_root, timeout=timeout + 5, env=_python_env(ui_root),
        input_text=json.dumps(decision, ensure_ascii=False, separators=(",", ":")),
    )
    if rc:
        raise RuntimeError("clarification_resolve_failed")
    return value


def resolve_capability(
    message: str,
    ui_root: Path = UI_ROOT,
    *,
    surface: str = "claw_live",
    caller: str = "owner",
    request_id: str | None = None,
) -> dict[str, Any]:
    rc, value, _ = _graph_cmd(
        "resolve",
        message,
        ui_root=ui_root,
        surface=surface,
        caller=caller,
        timeout=12,
        request_id=request_id,
    )
    if rc:
        raise RuntimeError("capability_resolve_failed")
    return value


def capability_first_eligibility(value: dict[str, Any]) -> tuple[str, str]:
    harness = value.get("harness") if isinstance(value.get("harness"), dict) else {}
    prepared = value.get("decision") if isinstance(value.get("decision"), dict) else {}
    decision_type = str(prepared.get("type") or "")
    decision_reason = str(prepared.get("reason") or harness.get("reason") or "")
    if decision_type == "EXECUTE":
        return "eligible", decision_reason or "capability_first"
    if decision_type == "CLARIFY":
        return "clarification", decision_reason or "intent_clarification_required"
    if decision_type == "STOP":
        return "known_error", decision_reason or "known_capability_stopped"
    if decision_type == "REASON":
        return ("miss" if harness.get("tool_policy") != "required" else "assist"), decision_reason or "model_allowed"
    selected = value.get("selected") if isinstance(value.get("selected"), dict) else None
    plan = value.get("skill_plan") if isinstance(value.get("skill_plan"), dict) else {}
    if harness.get("tool_policy") != "required":
        return "miss", str(harness.get("reason") or "model_allowed")
    if plan.get("mode") == "needs_clarification":
        return "clarification", "intent_clarification_required"
    if (
        plan.get("mode") in {"transfer", "degraded"}
        and str(plan.get("risk") or "") in HIGH_CONSEQUENCE_RISKS
        and plan.get("confirmation_required") is True
    ):
        return "known_error", "required_capability_not_ready"
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


_presentation_module = None

def _presentation_metadata(value):
    if not isinstance(value, dict) or not isinstance(value.get("presentation"), dict):
        return {}
    global _presentation_module
    if _presentation_module is None:
        spec = importlib.util.spec_from_file_location("_hs3_presentation_read", Path(__file__).with_name("receipt-presentation-read.py"))
        _presentation_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_presentation_module)
    return _presentation_module.read(value) or {}


def _understood_prefix(metadata, text):
    understood = (metadata.get("presentation") or {}).get("understood") if metadata else None
    line = understood.get("text") if isinstance(understood, dict) and understood.get("capability") else None
    return f"{line}\n{text}" if line and text else (text or line or "")


def _presentation_display(value):
    metadata = _presentation_metadata(value)
    return _presentation_module.display(metadata) if metadata else None


# Reuse the canonical memory import privacy boundary for free text only.
# Do not apply its number/OTP heuristic to structured telecom amounts.
_display_privacy_spec = importlib.util.spec_from_file_location(
    "_claw_display_context_import", Path(__file__).with_name("context_import.py"))
_display_privacy_owner = importlib.util.module_from_spec(_display_privacy_spec)
_display_privacy_spec.loader.exec_module(_display_privacy_owner)
_DISPLAY_SENSITIVE = _display_privacy_owner.SENSITIVE


def _plain_display(value: Any, maximum: int = 120) -> str:
    if not isinstance(value, str):
        return ""
    if _DISPLAY_SENSITIVE.search(value):
        return ""
    text = " ".join(value.split())[:maximum].strip()
    if not text or text.startswith(("{", "[")) or re.search(r"https?://|\bBearer\b|\+\d{8,}|\b(?:ghp_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]+", text, re.I):
        return ""
    return text


def _telecom_cards(value: dict[str, Any]) -> str:
    data = value.get("data") if isinstance(value.get("data"), dict) else value
    cards = data.get("cards")
    if not isinstance(cards, list):
        return ""
    lines = []
    skipped = 0
    for card in cards[:32]:
        if not isinstance(card, dict):
            skipped += 1
            continue
        label = _plain_display(card.get("label") or card.get("title"), 80)
        amount = card.get("value")
        unit = _plain_display(card.get("unit"), 20)
        if unit not in {"TND", "DT", "GO", "MO", "KO", "GB", "MB", "KB", "Minutes", "MIN", "SMS", "USD", "EUR", "DZD", "MAD", "IQD", "JOD", "JD", "LYD", "%"}:
            skipped += 1
            continue
        if not label or not unit or isinstance(amount, bool) or not re.fullmatch(r"-?\d{1,30}(?:[.,]\d{1,12})?", str(amount)):
            skipped += 1
            continue
        # One card per line: exact value, unit, validity. Never summed (cards of one unit are distinct counters).
        line = f"{label} : {amount} {unit}"
        days = card.get("days_remaining")
        # Real S24 capture (10/10 09:41): "Compte de recharge" carries 4100 days; bound at 100 years.
        if type(days) is int and 0 <= days <= 36500:
            line += f" — validité restante : {days} jour(s)"
        lines.append(line)
    if lines and skipped:
        lines.append(f"{skipped} autre(s) carte(s) non affichable(s) en texte.")
    return "\n".join(lines)


def _execution_provenance(selected: dict[str, Any], execution: dict[str, Any]) -> dict[str, str] | None:
    result = {}
    payload = execution.get("result") if isinstance(execution.get("result"), dict) else {}
    for key in ("capability", "route"):
        value = selected.get(key)
        if key == "route":
            if "actual_route" in execution:
                value = execution.get("actual_route")
            elif isinstance(payload.get("route_id"), str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,159}", payload["route_id"]):
                # Older receipts (S24 10/10 09:41) lack execution.actual_route; the owner result names the
                # route it really executed (orange.usage.maxit.v1 while the plan was orange.summary.maxit.v1).
                value = payload["route_id"]
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,159}", value):
            return None
        result[key] = value
    guard = payload.get("network_guard") if isinstance(payload.get("network_guard"), dict) else {}
    network_path = execution.get("network_path") or payload.get("network_path") or guard.get("path")
    if network_path in ("wifi_off", "cellular_bind_wifi_on"):
        result["network_path"] = network_path
    return result


def _display_text(value: Any, depth: int = 0, remaining: list[int] | None = None) -> str:
    remaining = [128] if remaining is None else remaining
    remaining[0] -= 1
    if depth >= 4 or remaining[0] < 0:
        return "Résultat disponible auprès de Claw ; détails non affichables en texte."
    if depth == 0:
        presented = _presentation_display(value)
        if presented:
            return presented
    if isinstance(value, dict):
        cards = _telecom_cards(value)
        if cards:
            return cards
        if value.get("strategy") == "composed_read" and isinstance(value.get("results"), list):
            lines = []
            for row in value["results"][:32]:
                if not isinstance(row, dict):
                    continue
                label = _plain_display(row.get("label") or row.get("target"), 80) or "Lecture"
                payload = row.get("result")
                if row.get("state") == "completed" and isinstance(payload, dict) and payload.get("ok") is True:
                    text = _display_text(payload, depth + 1, remaining)
                elif row.get("state") == "indeterminate":
                    text = "Résultat à vérifier ; lecture non rejouée."
                elif row.get("state") == "not_started":
                    text = "Lecture non exécutée."
                else:
                    text = "Lecture indisponible."
                line = label + " : " + text
                if sum(len(item) + 1 for item in lines) + len(line) > 8000:
                    break
                lines.append(line)
                if remaining[0] <= 0:
                    break
            if lines:
                return "\n".join(lines)
        for key in ("text", "message", "summary", "answer"):
            text = value.get(key)
            if isinstance(text, str) and _plain_display(text, 4000):
                return _plain_display(text, 4000)
        if value.get("state") == "needs_counter" and isinstance(value.get("choices"), list):
            choices = [_plain_display(x, 80) for x in value["choices"][:32] if _plain_display(x, 80)]
            if choices:
                return "Précise : " + " / ".join(choices)
        if value.get("state") == "needs_parameter":
            question = value.get("question")
            if isinstance(question, str) and _plain_display(question, 4000):
                return _plain_display(question, 4000)
        return _generic_display(value) or "Résultat disponible auprès de Claw ; détails non affichables en texte."
    if isinstance(value, list):
        return _generic_display({"résultats": value}) or "Résultat disponible auprès de Claw ; détails non affichables en texte."
    return _plain_display(value, 4000) or "Résultat disponible auprès de Claw."


# Executor bookkeeping, never shown (Amine 12/10 : affichage générique de tout résultat déterministe).
_GENERIC_HIDDEN = {"ok", "route", "route_id", "query", "request_count", "latency_ms", "duration_ms", "state",
                   "source", "version", "fallback_from", "route_selection_reason", "reason_code"}


def _generic_value(value: Any) -> str:
    if isinstance(value, bool):
        return "oui" if value else "non"
    if isinstance(value, (int, float)):
        return f"{value:g}" if isinstance(value, float) else str(value)
    return _plain_display(value, 160)


def _generic_display(value: dict[str, Any], limit: int = 24) -> str:
    """Readable lines for any executor result: scalar fields, one level of nested scalars, list sizes with
    their first rows. Bookkeeping keys and anything sensitive (_plain_display) are left out; bounded."""
    if value.get("ok") is False:
        return ""
    lines: list[str] = []
    label = lambda key: str(key).replace("_", " ").strip().capitalize()
    for key, item in value.items():
        if len(lines) >= limit or str(key) in _GENERIC_HIDDEN or str(key).endswith("_ms"):
            continue
        if isinstance(item, dict):
            parts = [f"{str(k).replace('_', ' ')} : {_generic_value(v)}" for k, v in list(item.items())[:12]
                     if not isinstance(v, (dict, list)) and _generic_value(v) and str(k) not in _GENERIC_HIDDEN]
            if parts:
                lines.append(f"{label(key)} : " + " ; ".join(parts))
        elif isinstance(item, list) and len(item) == 1 and isinstance(item[0], dict):
            # One result (« état du projet 20495 ») : its whole record, one field per line.
            for k, v in list(item[0].items())[:limit]:
                if str(k) not in _GENERIC_HIDDEN and not isinstance(v, (dict, list)) and _generic_value(v):
                    lines.append(f"{str(k).replace('_', ' ').capitalize()} : {_generic_value(v)}")
        elif isinstance(item, list):
            rows = []
            for row in item[:5]:
                if isinstance(row, dict):
                    cells = [_generic_value(v) for k, v in row.items() if str(k) not in _GENERIC_HIDDEN and not isinstance(v, (dict, list))]
                    cells = [c for c in cells if c][:4]
                    if cells:
                        rows.append(" · ".join(cells))
                elif _generic_value(row):
                    rows.append(_generic_value(row))
            head = f"{label(key)} : {len(item)}" if item else f"{label(key)} : aucun"
            lines.append(head + ("" if not rows else "\n" + "\n".join("- " + r for r in rows) + ("\n- …" if len(item) > 5 else "")))
        elif _generic_value(item):
            lines.append(f"{label(key)} : {_generic_value(item)}")
    return "\n".join(lines)[:4000]


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
    decision: dict[str, Any] | None = None,
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


def _stable_identity(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:32]
    return f"{prefix}:{digest}"


def _bridge_params_hash(method: str, params: dict[str, Any]) -> str:
    raw = json.dumps({"method": method, "params": params}, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _continuum_call(ui_root: Path, args: list[str], timeout: int = 15) -> dict[str, Any]:
    rc, value, _ = _run_json(
        [sys.executable, "-B", "-m", "skill_intelligence.continuum_ingress", *args],
        cwd=ui_root, timeout=timeout, env=_python_env(ui_root),
    )
    if rc:
        raise RuntimeError("continuum_ingress_failed")
    return value


def _bridge_cli(home: Path = HOME) -> Path:
    for path in (
        home / ".openclaw/releases/current/termux-lite/claw-bridge-cli.py",
        home / "ClawMobile/installer/termux-lite/claw-bridge-cli.py",
    ):
        if path.is_file():
            return path
    raise RuntimeError("remote_bridge_cli_unavailable")


def _bridge_status(request_id: str, *, timeout: int) -> dict[str, Any] | None:
    try:
        rc, value, _ = _run_json(
            [sys.executable, str(_bridge_cli()), "status", request_id],
            cwd=HOME, timeout=max(3, min(timeout, 20)), env=os.environ.copy(),
        )
        return value if rc == 0 and isinstance(value, dict) and value.get("requestId") else None
    except (OSError, RuntimeError, subprocess.SubprocessError):
        return None


def _durable_capability_execute(
    resolution: dict[str, Any],
    message: str,
    *,
    ui_root: Path,
    surface: str,
    caller: str,
    origin_id: str,
    timeout: int,
    decision: dict[str, Any] | None = None,
) -> dict[str, Any]:
    selected = resolution.get("selected") if isinstance(resolution.get("selected"), dict) else {}
    capability = str(selected.get("capability") or resolution.get("capability") or "").strip()
    risk = str(selected.get("risk") or "read")
    if not capability:
        raise RuntimeError("durable_capability_missing")
    if not origin_id or origin_id == "capability-first":
        return {**resolution, "execution": {"state": "durable_identity_required"}}
    task_id = _stable_identity("capfirst", origin_id)
    step_id = "execute"
    request_id = "capfirst-" + hashlib.sha256((task_id + ":" + step_id).encode()).hexdigest()[:32]
    method = "capability_execute_readonly" if risk == "read" else "capability_execute_owner"
    params = {"request": message, "targetHint": "", "surface": surface, "caller": caller}
    if isinstance(decision, dict):
        params["decision"] = decision
    owner_id = "capfirst-" + hashlib.sha256(origin_id.encode()).hexdigest()[:24]
    prepared = _continuum_call(ui_root, [
        "prepare", "--task-id", task_id, "--step-id", step_id,
        "--request-id", request_id, "--method", method,
        "--params-hash", _bridge_params_hash(method, params),
        "--capability", capability, "--risk", risk, "--owner-id", owner_id,
        "--protocol", "one-shot",
    ])
    receipt = None
    if prepared.get("state") in {"observe_existing", "step_settled", "terminal"}:
        receipt = _bridge_status(request_id, timeout=timeout)
        if receipt is None:
            return {**resolution, "execution": {"state": "verification_required", "reason": prepared.get("state")},
                    "continuum": prepared}
    elif prepared.get("state") == "ready" and prepared.get("dispatch_allowed") is True:
        cmd = [sys.executable, str(_bridge_cli()), "submit",
               "--request-id", request_id, "--task-id", task_id,
               "--step-id", str(prepared.get("wire_step_id") or step_id),
               "--method", method, "--params-json", json.dumps(params, ensure_ascii=False, separators=(",", ":"))]
        fence = prepared.get("continuum_fence")
        if fence:
            cmd += ["--continuum-fence-json", json.dumps(fence, ensure_ascii=False, separators=(",", ":"))]
        try:
            rc, candidate, _ = _run_json(cmd, cwd=HOME, timeout=max(3, min(timeout + 5, 125)), env=os.environ.copy())
            if rc == 0 and isinstance(candidate, dict) and candidate.get("requestId") == request_id:
                receipt = candidate
        except (OSError, RuntimeError, subprocess.SubprocessError):
            receipt = None
        # Response delivery failure is observation-only: one status lookup, never a second submit.
        if receipt is None:
            receipt = _bridge_status(request_id, timeout=timeout)
    else:
        return {**resolution, "execution": {"state": str(prepared.get("state") or "verification_required")},
                "continuum": prepared}

    if not receipt:
        return {**resolution, "execution": {"state": "verification_required", "reason": "receipt_unavailable"},
                "continuum": prepared}
    try:
        settled = _continuum_call(ui_root, ["settle", "--task-id", task_id,
            "--request-id", request_id, "--protocol", "one-shot"])
    except (OSError, RuntimeError, subprocess.SubprocessError):
        settled = {"state": "verification_required", "retry_authorized": False}
    if receipt.get("state") != "completed" or not isinstance(receipt.get("result"), dict):
        return {**resolution, "execution": {"state": str(receipt.get("state") or "verification_required"),
                    "reason": "durable_receipt_not_completed"}, "continuum": settled}
    result = dict(receipt["result"])
    result["continuum"] = settled
    return result


def _known_error_text(reason: str, resolution: dict[str, Any]) -> str:
    if reason == "required_capability_not_ready":
        plan = resolution.get("skill_plan") if isinstance(resolution.get("skill_plan"), dict) else {}
        target = str(plan.get("target") or "ce fournisseur").strip()
        label = target.upper() if target and len(target) <= 24 else target
        if str(plan.get("risk") or "") == "transaction":
            return (
                f"Le paiement {label} est reconnu par Claw, mais son adaptateur "
                "n'est pas encore validé. Aucun paiement n'a été lancé."
            )
        return "Cette action est reconnue par Claw, mais sa route d'exécution n'est pas encore validée."
    if reason == "selected_not_authorized":
        return "Cette action existe dans Claw mais n'est pas autorisée pour ce demandeur."
    return "Cette action connue ne peut pas être exécutée par Claw dans son état actuel."


def try_fast_path(
    message: str,
    ui_root: Path = UI_ROOT,
    *,
    execute: bool = True,
    surface: str = "claw_live",
    caller: str = "owner",
    origin_id: str = "capability-first",
    timeout: int = 30,
    prepared_decision: dict[str, Any] | None = None,
    clarification_decision: dict[str, Any] | None = None,
    clarification_original_text: str | None = None,
) -> dict[str, Any]:
    try:
        if clarification_decision is not None:
            if not clarification_original_text:
                raise ValueError("clarification_original_text_required")
            resolved_clarification = resolve_clarification(
                message, clarification_original_text, clarification_decision, ui_root,
                request_id=origin_id, timeout=min(timeout, 15),
            )
            clarification_meta = resolved_clarification.get("clarification_resolution") if isinstance(resolved_clarification.get("clarification_resolution"), dict) else {}
            clarification_state = str(clarification_meta.get("state") or "")
            if clarification_state == "unrelated":
                return {"status": "clarification_unrelated", "reason": "new_topic", "model_bypassed": True}
            if clarification_state == "pending":
                return {
                    "status": "clarification",
                    "reason": "intent_clarification_required",
                    "text": str(clarification_meta.get("question") or "Précise ce que tu veux faire."),
                    "clarification": {"question": clarification_meta.get("question"), "choices": clarification_meta.get("choices") or []},
                    "decision": clarification_decision,
                    "model_bypassed": True,
                }
            if clarification_state != "resolved":
                return {"status": "known_error", "reason": "clarification_invalid", "text": "La clarification Claw n'est plus valide.", "model_bypassed": True}
            resolution = resolved_clarification
            decision = resolution.get("decision") if isinstance(resolution.get("decision"), dict) else {}
        elif prepared_decision is not None:
            checked = validate_prepared_decision(message, prepared_decision, ui_root, timeout=min(timeout, 15))
            if checked.get("state") != "valid":
                return {
                    "status": "known_error",
                    "reason": str(checked.get("reason") or checked.get("state") or "decision_invalid"),
                    "text": "La décision Claw doit être revalidée avant toute exécution.",
                    "decision": prepared_decision,
                    "model_bypassed": True,
                }
            decision = checked.get("decision") if isinstance(checked.get("decision"), dict) else prepared_decision
            resolution = checked.get("resolution") if isinstance(checked.get("resolution"), dict) else {}
        else:
            resolution = resolve_capability(
                message, ui_root, surface=surface, caller=caller, request_id=origin_id,
            )
            decision = resolution.get("decision") if isinstance(resolution.get("decision"), dict) else {}

        decision_state, reason = capability_first_eligibility(resolution)
        if decision_state == "miss":
            return {"status": "miss", "reason": reason, "resolution": resolution, "decision": decision or None}
        if decision_state == "assist":
            return {"status": "assist", "reason": reason, "resolution": resolution, "decision": decision or None}
        if decision_state == "clarification":
            clarification = resolution.get("clarification") if isinstance(resolution.get("clarification"), dict) else {}
            question = str(clarification.get("question") or "Précise ce que tu veux faire.").strip()
            return {
                "status": "clarification", "reason": reason, "text": question,
                "clarification": clarification, "resolution": resolution, "decision": decision or None,
                "model_bypassed": True,
            }
        if decision_state == "known_error":
            return {
                "status": "known_error", "reason": reason,
                "text": _known_error_text(reason, resolution),
                "resolution": resolution, "decision": decision or None, "model_bypassed": True,
            }
        if not execute:
            return {
                "status": "eligible", "reason": reason, "resolution": resolution,
                "decision": decision or None, "model_bypassed": True,
            }

        if resolution.get("confirmation_required") is True:
            return _execute_declared_handoff(
                resolution, message, ui_root=ui_root, surface=surface, caller=caller,
                origin_id=origin_id, timeout=timeout,
            ) | {"decision": decision or None}

        continuum = resolution.get("continuum") if isinstance(resolution.get("continuum"), dict) else {}
        # Read execution only (the confirmed handoff above keeps its own budget): O6 guarded wait.
        execution_timeout = guarded_execution_timeout(
            timeout, resolution.get("selected"), decision.get("selected") if isinstance(decision, dict) else None,
        )
        if continuum.get("mode") == "durable":
            executed = _durable_capability_execute(
                resolution, message, ui_root=ui_root, surface=surface, caller=caller,
                origin_id=origin_id, timeout=execution_timeout, decision=decision or None,
            )
        else:
            executed = (
                execute_capability_decision(message, decision, ui_root, timeout=execution_timeout)
                if decision
                else execute_capability(message, ui_root, surface=surface, caller=caller, timeout=execution_timeout)
            )
        execution = executed.get("execution") if isinstance(executed.get("execution"), dict) else {}
        state = str(execution.get("state") or "")
        selected = executed.get("selected") if isinstance(executed.get("selected"), dict) else {}
        metadata = _presentation_metadata(executed)
        if state in SAFE_EXECUTION_STATES:
            payload = execution.get("result")
            return {
                # Business rendering of the owner result (O7 cards…), preceded by the HS3 « Compris » line.
                "status": "hit", "source": "capability", "text": _understood_prefix(metadata, _display_text(payload)),
                **metadata,
                "result": payload, "target": selected.get("target"), "intent": selected.get("intent"),
                "route": selected.get("route"), "capability": selected.get("capability"),
                "execution_state": state, "decision": executed.get("decision") or decision or None,
                "provenance": _execution_provenance(selected, execution),
                "model_bypassed": True,
            }
        if state == "needs_clarification" and isinstance(executed.get("decision"), dict) and executed["decision"].get("type") == "CLARIFY":
            # Amine 12/10 : several matches → one question listing them; nothing was executed.
            choices = [c for c in (execution.get("choices") or []) if isinstance(c, dict) and _plain_display(c.get("label"), 120)]
            question = _plain_display(execution.get("question"), 300) or "Lequel veux-tu ?"
            return {
                "status": "clarification", "reason": "choice_required",
                "text": question + "".join("\n- " + _plain_display(c.get("label"), 120) for c in choices),
                "clarification": {"question": question, "choices": choices},
                "decision": executed["decision"], "model_bypassed": True,
            }
        if state in ASSISTED_EXECUTION_STATES:
            return {"status": "assist", "reason": state, "resolution": executed, "decision": decision or None, **metadata}
        if state == "confirmation_required":
            handed = _execute_declared_handoff(
                executed, message, ui_root=ui_root, surface=surface, caller=caller,
                origin_id=origin_id, timeout=timeout,
            ) | {"decision": executed.get("decision") or decision or None}
            # The Graph metadata describes the pending confirmation (« Compris : … ») only
            # when the handoff opened; a failed handoff keeps the generic error fallback.
            return handed | metadata if handed.get("status") == "hit" else handed
        payload = execution.get("result")
        composed = (selected.get("execution_contract") or {}).get("strategy") == "composed_read"
        error_result = {
            "status": "known_error", "reason": state or "known_execution_failed",
            **metadata,
            "text": "Claw a identifié la capacité mais son exécution n'a pas atteint un état terminal vérifié.",
            "resolution": executed, "decision": executed.get("decision") or decision or None,
            "model_bypassed": True,
            "provenance": _execution_provenance(selected, execution),
        }
        if composed and isinstance(payload, dict):
            error_result.update(text=_display_text(payload), result=payload, execution_state=state)
        if metadata:
            error_result["text"] = _display_text(executed)
        return error_result
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        return {"status": "error", "reason": type(exc).__name__, "detail": str(exc)[:800]}


def main() -> int:
    parser = argparse.ArgumentParser(description="Capability-first pre-model Claw ingress.")
    parser.add_argument("--check", action="store_true", help="Resolve only; do not execute or open a human boundary.")
    parser.add_argument("--execute-decision", action="store_true", help="Execute the prepared decision from CLAW_PREPARED_DECISION_B64 without re-resolving.")
    parser.add_argument("--resolve-clarification", action="store_true", help="Resolve the reply against the pending clarification decision.")
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
    prepared = None
    clarification_decision = None
    clarification_original = None
    if args.execute_decision or args.resolve_clarification:
        raw = os.environ.get("CLAW_PREPARED_DECISION_B64", "")
        try:
            parsed = json.loads(base64.b64decode(raw.encode("ascii"), validate=True).decode("utf-8"))
            if not isinstance(parsed, dict):
                raise ValueError("decision_object_required")
        except Exception:
            raise SystemExit("invalid_prepared_decision")
        if args.execute_decision:
            prepared = parsed
        else:
            clarification_decision = parsed
            original_raw = os.environ.get("CLAW_CLARIFICATION_ORIGINAL_B64", "")
            try:
                clarification_original = base64.b64decode(original_raw.encode("ascii"), validate=True).decode("utf-8")
            except Exception:
                raise SystemExit("invalid_clarification_original")
    result = try_fast_path(
        message, args.ui_root, execute=not args.check, surface=args.surface, caller=args.caller,
        origin_id=args.origin_id, timeout=max(2, min(args.timeout, 120)), prepared_decision=prepared,
        clarification_decision=clarification_decision, clarification_original_text=clarification_original,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") in {"hit", "eligible", "miss", "assist", "clarification", "known_error"} else 75


if __name__ == "__main__":
    raise SystemExit(main())
