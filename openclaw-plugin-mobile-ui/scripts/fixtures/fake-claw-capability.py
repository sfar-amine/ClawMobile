#!/usr/bin/env python3
import base64
import json
import sys

mode = sys.argv[1]
request = sys.argv[2]
args = sys.argv[3:]
is_write = "wifi" in request.lower()
is_delegate = "delegate" in request.lower()
is_durable_read = "durable read" in request.lower()
risk = "write" if is_write else "read"
capability = "engineering.autonomous" if is_delegate else "device.assistance"
continuum = {
    "mode": "durable" if (is_write or is_durable_read) else "fast",
    "durable": bool(is_write or is_durable_read),
    "identity_required": bool(is_write or is_durable_read),
    "rollout_class": "device_effect" if is_write else "long_read" if is_durable_read else "short_read",
}

def decision():
    kind = "REASON" if is_delegate else "EXECUTE"
    return {
        "version": 2,
        "decisionId": "fake-" + ("delegate" if is_delegate else "write" if is_write else "read"),
        "requestId": "fake-request",
        "type": kind,
        "reason": "selected_requires_model" if is_delegate else "capability_first",
        "surface": "external_mcp",
        "caller": "owner",
        "textHash": "fixture",
        "capabilityRevision": "fixture-revision",
        "contractHash": "fixture-contract",
        "target": None,
        "intent": None,
        "capability": capability,
        "route": None,
        "risk": risk,
        "confidence": 1.0,
        "confirmationRequired": False,
        "humanBoundary": None,
        "requiredSlots": [],
        "plan": {},
        "selected": {
            "capability": capability,
            "executor": "claw.capability" if is_delegate else "claw.capability_runtime",
            "risk": risk,
            "deterministic": not is_delegate,
            "authorized": True,
            "native": False,
            "state": "ready",
        },
        "harness": {"tool_policy": "required"},
        "continuum": continuum,
        "clarification": None,
    }

def base(dec=None):
    surface = args[args.index("--surface") + 1] if "--surface" in args else "external_mcp"
    caller = args[args.index("--caller") + 1] if "--caller" in args else "owner"
    value = {
        "surface": surface,
        "caller": caller,
        "capability": capability,
        "selected": {
            "capability": capability,
            "executor": "claw.capability" if is_delegate else "claw.capability_runtime",
            "risk": risk,
            "deterministic": not is_delegate,
            "authorized": True,
            "native": False,
            "state": "ready",
        },
        "confirmation_required": False,
        "continuum": continuum,
    }
    if dec is not None:
        value["decision"] = dec
    return value

if mode in {"validate-decision", "execute-decision"}:
    encoded = args[args.index("--decision-b64") + 1]
    prepared = json.loads(base64.b64decode(encoded).decode("utf-8"))
    if mode == "validate-decision":
        print(json.dumps({
            "state": "valid",
            "decision": prepared,
            "resolution": base(prepared),
            "revalidated": False,
        }))
        raise SystemExit(0)
    out = base(prepared)
    if "--read-only" in args and (prepared.get("risk") != "read" or is_delegate):
        out["execution"] = {"state": "blocked", "reason": "read_only_policy"}
    elif is_delegate or prepared.get("type") == "REASON":
        out["execution"] = {
            "state": "delegation_required",
            "executor": "claw.capability",
            "capability": "engineering.autonomous",
        }
    else:
        out["execution"] = {
            "state": "completed",
            "result": {"ok": True, "request": request, "decisionId": prepared.get("decisionId")},
        }
    print(json.dumps(out))
    raise SystemExit(0)

out = base(decision())
if mode == "execute":
    if "--read-only" in args and (is_write or is_delegate):
        out["execution"] = {"state": "blocked", "reason": "read_only_policy"}
    elif is_delegate:
        out["execution"] = {
            "state": "delegation_required",
            "executor": "claw.capability",
            "capability": "engineering.autonomous",
        }
    else:
        out["execution"] = {
            "state": "completed",
            "result": {"ok": True, "request": request},
        }

print(json.dumps(out))
