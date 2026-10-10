#!/usr/bin/env python3
"""Post-deploy acceptance of the loopback Companion: every owner route must answer within its budget,
refuse what it must refuse, and never return secret-shaped content. Read-only: no mutation is sent.

Exit 0 = accepted, 1 = regression (the deploy script rolls back), 2 = usage error.
A route that is not present in this build (404) is skipped, so the same check serves every release."""
import json, re, sys, time, urllib.error, urllib.request

BASE = "http://127.0.0.1:8765/v1"
# (path, budget seconds). Existing budgets were measured on S24; R8 user28 targets are locally tested and still require live qualification. A cold first read gets one retry.
READS = [
    ("/health", 2.0),
    ("/whatsapp/allowlist", 10.0),
    ("/whatsapp/allowlist/history?limit=50", 10.0),
    ("/security/surfaces", 1.5),
    ("/notifications/sources", 6.0),
    ("/runs?limit=50", 4.0),
    ("/control/engineering?limit=20", 2.0),
    ("/control/diagnostic/export", 3.0),
    ("/updates", 4.0),
    ("/control/memory?limit=20", 3.0),
    ("/agent/config", 9.0),
    ("/laptop-access/computers", 6.0),
    ("/security/surfaces", 2.0),
    # R8 user28 budgets; real recording volume is zero (captured producer forms are mock traces).
    ("/skills/candidates?limit=50", 1.5),
    ("/voice/voices", 1.0),
    ("/control/automations?contract=2", 1.0),
    # P2-b: an installed workspace skill on the S24 (fixtures/s24-2026-10-10/gateway/skills.status.json).
    # The Gateway wait is capped at 3 s (then partial); skills.status measured 1.8-2.4 s.
    ("/skills/clawmobile-capabilities", 4.0),
]
# Mutations sent WITHOUT the owner header must be refused before any effect.
OWNER_GUARDS = [
    ("POST", "/attachments"),
    ("POST", "/security/surfaces"),
    ("POST", "/automations/acceptance-probe/run"),
    ("POST", "/control/requests/REQ-0/cancel"),
    ("POST", "/agent/config"),
    ("POST", "/skills/learn"),
    ("POST", "/control/memory/import/preview"),
    ("POST", "/control/memory/import"),
    ("POST", "/control/memory/" + "a" * 64 + "/forget"),
    ("POST", "/runs/acceptance-probe/approval"),
    ("POST", "/whatsapp/allowlist"),
    ("POST", "/skills/clawmobile-capabilities/disable"),
    ("POST", "/skills/clawmobile-capabilities/enable"),
    ("POST", "/skills/clawmobile-capabilities/try"),
    ("POST", "/files"),
    ("POST", "/files/content"),
]
OWNER_GUARD_BUDGETS = {"/skills/learn": 2.0}  # admission/refusal budget, no effect without owner proof
SETTLE_SECONDS = 15
# R20 file reads (owner Gateway, deferred while warming). Judged on the settled answer, never failed unconditionally.
FILE_READS = [
    ("/files?scope=agent", 1.5),
    ("/files?scope=session", 1.5),
    ("/files/content?scope=agent&path=AGENTS.md", 2.0),
    ("/files/content?scope=session&path=IDENTITY.md", 2.0),
]
# Secrets only: preserve the acceptance policy of the runtime base.
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
    results, failed, candidate_id = [], False, None
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
        if path == "/skills/candidates?limit=50" and code == 200:
            try:
                items = json.loads(body).get("items")
                if not isinstance(items, list): raise ValueError("candidate_projection_invalid")
                if items:
                    identifier = items[0].get("traceId")
                    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", identifier) or identifier in (".", ".."):
                        raise ValueError("candidate_projection_invalid")
                    candidate_id = identifier
            except (ValueError, AttributeError, TypeError):
                failed = True
    # Exercise the detail only with an existing owner artifact, never a fabricated trace.
    if candidate_id is not None:
        budget = 1.0  # user28 detail-read budget
        path = "/skills/candidates/" + candidate_id
        code, body, took = call("GET", path, budget + 5)
        leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
        status = "ok" if code == 200 and took <= budget and not leak else "fail"
        failed |= status == "fail"
        results.append({"route": "/skills/candidates/{traceId}", "code": code, "seconds": round(took, 2), "budget": budget, "leak": leak, "status": status})
    for path, budget in FILE_READS:
        code, body, took = call("GET", path, budget + 5)
        settled = settle(path, body) if code == 200 else True
        if code == 200 and settled:
            # The leak check reads the settled (cached) answer, not the "warming" placeholder.
            code, body, _ = call("GET", path, budget + 5)
        leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
        status = "skipped" if code == 404 else ("ok" if code == 200 and took <= budget and settled and not leak else "fail")
        failed |= status == "fail"
        results.append({"route": path, "code": code, "seconds": round(took, 2), "budget": budget, "leak": leak, "settled": settled, "status": status})
    for method, path in OWNER_GUARDS:
        budget = OWNER_GUARD_BUDGETS.get(path, 10.0)
        code, _, took = call(method, path, budget)
        status = "skipped" if code == 404 else ("ok" if code in (400, 403, 405) and took <= budget else "fail")
        failed |= status == "fail"
        results.append({"route": method + " " + path + " (no owner header)", "code": code, "seconds": round(took, 2), "budget": budget, "status": status})
    print(json.dumps({"accepted": not failed, "checks": results}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
