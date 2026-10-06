#!/usr/bin/env python3
import json
import sys

mode = sys.argv[1]
request = sys.argv[2]
args = sys.argv[3:]
surface = args[args.index("--surface") + 1]
caller = args[args.index("--caller") + 1]
is_write = "wifi" in request.lower()
is_delegate = "delegate" in request.lower()

out = {
    "surface": surface,
    "caller": caller,
    "capability": "engineering.autonomous" if is_delegate else "device.assistance",
    "selected": {
        "capability": "engineering.autonomous" if is_delegate else "device.assistance",
        "executor": "claw.capability" if is_delegate else "claw.capability_runtime",
        "risk": "write" if is_write else "read",
        "deterministic": not is_delegate,
        "authorized": True,
        "native": False,
    },
    "confirmation_required": False,
}

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
