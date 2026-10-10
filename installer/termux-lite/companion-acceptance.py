#!/usr/bin/env python3
"""Post-deploy acceptance of the loopback Companion: every owner route must answer within its budget,
refuse what it must refuse, and never return secret-shaped content. Read-only: no mutation is sent.

Exit 0 = accepted, 1 = regression (the deploy script rolls back), 2 = usage error.
A route that is not present in this build (404) is skipped, so the same check serves every release."""
import argparse, json, re, sys, time, urllib.error, urllib.request, urllib.parse

BASE = "http://127.0.0.1:8765/v1"
# (path, budget seconds). Budgets are S24 numbers measured on 10/10 with margin; a cold first call gets one retry.
READS = [
    ("/health", 2.0),
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
    ("POST", "/files"),
    ("PUT", "/files/content"),
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file-session-id", help="Existing non-financial dedicated fixture session, supplied by Claude")
    parser.add_argument("--file-path", help="Safe root-relative file path of that dedicated fixture")
    args = parser.parse_args()
    results, failed = [], False
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
    # R20 draft evidence stays pending until the installed owner is qualified.
    code, body, took = call("GET", "/files?scope=agent", 1.5)
    try:
        projected = json.loads(body)
    except (ValueError, TypeError):
        projected = {}
    file_status = "skipped" if code == 404 else ("pending" if code == 202 or (code == 200 and projected.get("installedSchemaQualified") is False) else "fail")
    if took > 1.5 and code != 404:
        file_status = "fail"
    failed |= file_status in ("pending", "fail")
    results.append({"route": "/files?scope=agent", "code": code, "seconds": round(took, 2), "budget": 1.5, "status": file_status})
    if code != 404:
        if args.file_session_id and args.file_path:
            fixture = urllib.parse.urlencode({"scope": "session", "sessionId": args.file_session_id, "path": args.file_path})
            content_code, content_body, content_time = call("GET", "/files/content?" + fixture, 2.0)
            try:
                content_projection = json.loads(content_body)
            except (ValueError, TypeError):
                content_projection = {}
            content_status = "pending" if content_time <= 2 and (content_code == 202 or (content_code == 200 and content_projection.get("installedSchemaQualified") is False)) else "fail"
            results.append({"route": "/files/content (dedicated fixture)", "code": content_code, "seconds": round(content_time, 2), "budget": 2.0, "status": content_status})
        else:
            results.append({"route": "/files/content (dedicated fixture required)", "budget": 2.0, "status": "pending"})
        failed = True
    for method, path in OWNER_GUARDS:
        code, _, took = call(method, path, 10)
        status = "skipped" if code == 404 else ("ok" if code in (400, 403, 405) else "fail")
        failed |= status == "fail"
        results.append({"route": method + " " + path + " (no owner header)", "code": code, "seconds": round(took, 2), "status": status})
    print(json.dumps({"accepted": not failed, "checks": results}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
