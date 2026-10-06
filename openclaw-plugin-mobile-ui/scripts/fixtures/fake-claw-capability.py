#!/usr/bin/env python3
import json
import sys

mode = sys.argv[1]
request = sys.argv[2]
args = sys.argv[3:]
surface = args[args.index("--surface") + 1]
caller = args[args.index("--caller") + 1]
is_write = "wifi" in request.lower()

out = {
    "surface": surface,
    "caller": caller,
    "selected": {
        "executor": "claw.capability_runtime",
        "risk": "write" if is_write else "read",
        "deterministic": True,
        "authorized": True,
        "native": False,
    },
    "confirmation_required": False,
}

if mode == "execute":
    if "--read-only" in args and is_write:
        out["execution"] = {"state": "blocked", "reason": "read_only_policy"}
    else:
        out["execution"] = {
            "state": "completed",
            "result": {"ok": True, "request": request},
        }

print(json.dumps(out))
