#!/usr/bin/env python3
"""Post-deploy acceptance of the loopback Companion: every owner route must answer within its budget,
refuse what it must refuse, and never return secret-shaped content. Read-only: no mutation is sent.

Exit 0 = accepted, 1 = regression (the deploy script rolls back), 2 = usage error.
A route that is not present in this build (404) is skipped, so the same check serves every release."""
import json, re, sys, time, urllib.error, urllib.request

BASE = "http://127.0.0.1:8765/v1"
# (path, budget seconds). Budgets are S24 numbers measured on 10/10 with margin; a cold first call gets one retry.
READS = [
    ("/health", 2.0),
    ("/notifications/sources", 6.0),
    ("/runs?limit=50", 4.0),
    ("/conversations?limit=50", 0.3),
    ("/control/engineering?limit=20", 2.0),
    ("/control/diagnostic/export", 3.0),
    ("/updates", 4.0),
    ("/agent/config", 9.0),
    ("/laptop-access/computers", 6.0),
    ("/security/surfaces", 2.0),
    ("/voice/voices", 1.0),
    ("/control/automations?contract=2", 1.0),
]
# Mutations sent WITHOUT the owner header must be refused before any effect.
OWNER_GUARDS = [
    ("POST", "/automations/acceptance-probe/run"),
    ("POST", "/control/requests/REQ-0/cancel"),
    ("POST", "/agent/config"),
    ("POST", "/runs/acceptance-probe/approval"),
]
LEAK = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|refresh_token|access_token|-----BEGIN [A-Z ]*PRIVATE KEY|\+\d{11,}")


def call(method, path, timeout, headers=None):
    req = urllib.request.Request(BASE + path, method=method, data=b"{}" if method != "GET" else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    began = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(1 << 20), time.monotonic() - began
    except urllib.error.HTTPError as e:
        return e.code, e.read(1 << 20), time.monotonic() - began
    except Exception:
        return 0, b"", time.monotonic() - began


def main():
    results, failed, conversation_id = [], False, None
    for path, budget in READS:
        for attempt in (1, 2):
            code, body, took = call("GET", path, budget + 5)
            ok = code == 200 and took <= budget
            if ok or code == 404 or attempt == 2:
                break
        leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
        status = "skipped" if code == 404 else ("ok" if ok and not leak else "fail")
        failed |= status == "fail"
        results.append({"route": path, "code": code, "seconds": round(took, 2), "budget": budget, "leak": leak, "status": status})
        if path == "/conversations?limit=50" and code == 200:
            try:
                items = json.loads(body).get("items")
                if not isinstance(items, list): raise ValueError("conversation_projection_invalid")
                if items:
                    identifier = items[0].get("sessionId")
                    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", identifier) or len(identifier) > 80:
                        raise ValueError("conversation_projection_invalid")
                    conversation_id = identifier
            except (ValueError, AttributeError, TypeError):
                failed = True
    # Use a real retained conversation, never a fabricated owner session.
    budget = 10.0
    if conversation_id is not None:
        code, body, took = call("GET", "/conversations/" + conversation_id + "/metadata", budget + 5)
        leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
        status = "ok" if code == 200 and took <= budget and not leak else "fail"
    else:
        code, took, leak, status = None, 0, False, "unqualified"
    failed |= status != "ok"
    results.append({"route": "/conversations/{sessionId}/metadata", "code": code, "seconds": round(took, 2), "budget": budget, "leak": leak, "status": status})
    for method, path in OWNER_GUARDS:
        code, _, took = call(method, path, 10)
        status = "skipped" if code == 404 else ("ok" if code in (400, 403, 405) else "fail")
        failed |= status == "fail"
        results.append({"route": method + " " + path + " (no owner header)", "code": code, "seconds": round(took, 2), "status": status})
    print(json.dumps({"accepted": not failed, "checks": results}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
