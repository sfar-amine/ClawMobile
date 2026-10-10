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
    ("/usage", 6.0),
    ("/providers", 6.0),
    ("/security/surfaces", 1.5),
    ("/notifications/sources", 6.0),
    ("/runs?limit=50", 4.0),
    ("/conversations?limit=50", 0.3),
    ("/control/engineering?limit=20", 2.0),
    ("/control/diagnostic/export", 3.0),
    ("/updates", 4.0),
    ("/control/memory?limit=20", 3.0),
    ("/agent/config", 9.0),
    ("/laptop-access/computers", 6.0),
    ("/security/surfaces", 2.0),
    ("/voice/voices", 1.0),
    ("/control/automations?contract=2", 1.0),
]
# Mutations sent WITHOUT the owner header must be refused before any effect.
OWNER_GUARDS = [
    ("POST", "/security/surfaces"),
    ("POST", "/automations/acceptance-probe/run"),
    ("POST", "/control/requests/REQ-0/cancel"),
    ("POST", "/agent/config"),
    ("POST", "/control/memory/import/preview"),
    ("POST", "/control/memory/import"),
    ("POST", "/control/memory/" + "a" * 64 + "/forget"),
    ("POST", "/runs/acceptance-probe/approval"),
]
SETTLE_SECONDS = 15
# Secrets only. Phone numbers and owner-written text (titles, memory, contacts) legitimately appear in owner
# responses: matching them here would roll back healthy deploys (10/10 review of R11, P2-d, R17).
LEAK = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|refresh_token|access_token|-----BEGIN [A-Z ]*PRIVATE KEY")


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


def settle(path, body):
    """A 200 that only says "deferred" is not an answer: it must deliver data within SETTLE_SECONDS.
    (10/10: R5 answered "deferred" forever on the S24 because its revision source did not exist there.)"""
    deadline = time.monotonic() + SETTLE_SECONDS
    while True:
        try:
            doc = json.loads(body or b"{}")
        except ValueError:
            return True
        # Only "deferred" is judged: a section may legitimately be unavailable on a given phone.
        if (doc.get("computation") or {}).get("deliveryMode") != "deferred":
            return True
        if time.monotonic() > deadline:
            return False
        time.sleep(0.5)
        code, body, _ = call("GET", path, 10)
        if code != 200:
            return False


def main():
    results, failed, conversation_id = [], False, None
    for path, budget in READS:
        for attempt in (1, 2):
            code, body, took = call("GET", path, budget + 5)
            ok = code == 200 and took <= budget
            if ok or code == 404 or attempt == 2:
                break
        leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
        settled = settle(path, body) if code == 200 else True
        status = "skipped" if code == 404 else ("ok" if ok and not leak and settled else "fail")
        failed |= status == "fail"
        results.append({"route": path, "code": code, "seconds": round(took, 2), "budget": budget, "leak": leak, "settled": settled, "status": status})
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
