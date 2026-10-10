#!/usr/bin/env python3
"""Post-deploy acceptance of the loopback Companion: every owner route must answer within its budget,
refuse what it must refuse, and never return secret-shaped content. Read-only: no mutation is sent.

Exit 0 = accepted, 1 = regression or pending mandatory qualification (deploy rolls back), 2 = usage error.
A route that is not present in this build (404) is skipped, so the same check serves every release."""
import argparse, json, re, sys, time, urllib.error, urllib.request, urllib.parse

BASE = "http://127.0.0.1:8765/v1"
# (path, budget seconds). Existing budgets measured on S24 with margin; R20 budgets below are requirements, still unqualified.
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
        if LEAK.search(body.decode("utf-8", "replace")):
            return False
        if (doc.get("computation") or {}).get("deliveryMode") != "deferred":
            return True
        if time.monotonic() > deadline:
            return False
        time.sleep(0.5)
        code, body, _ = call("GET", path, 10)
        if code not in (200, 202):
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
    # R20: owner data may warm, but cannot remain deferred indefinitely.
    file_route = "/files?scope=agent"
    code, body, took = call("GET", file_route, 1.5)
    settled = settle(file_route, body) if code in (200, 202) else True
    leak = bool(LEAK.search(body.decode("utf-8", "replace")))
    file_status = "skipped" if code == 404 else "ok" if code in (200, 202) and took <= 1.5 and settled and not leak else "fail"
    failed |= file_status == "fail"
    results.append({"route": file_route, "code": code, "seconds": round(took, 2), "budget": 1.5, "settled": settled, "status": file_status})
    if code != 404:
        # Root agent file is available on every configured installation; no
        # private identity supplied by the caller is needed to probe it.
        fixture = urllib.parse.urlencode({"scope": "session", "sessionId": args.file_session_id, "path": args.file_path}) if args.file_session_id and args.file_path else "scope=agent&path=AGENTS.md"
        content_route = "/files/content?" + fixture
        content_code, content_body, content_time = call("GET", content_route, 2.0)
        content_settled = settle(content_route, content_body) if content_code in (200, 202) else True
        content_leak = bool(LEAK.search(content_body.decode("utf-8", "replace")))
        content_status = "skipped" if content_code == 404 else "ok" if content_code in (200, 202) and content_time <= 2.0 and content_settled and not content_leak else "fail"
        failed |= content_status == "fail"
        results.append({"route": "/files/content (owner fixture)", "code": content_code, "seconds": round(content_time, 2), "budget": 2.0, "settled": content_settled, "status": content_status})
    for method, path in OWNER_GUARDS:
        code, _, took = call(method, path, 10)
        status = "skipped" if code == 404 else ("ok" if code in (400, 403, 405) else "fail")
        failed |= status == "fail"
        results.append({"route": method + " " + path + " (no owner header)", "code": code, "seconds": round(took, 2), "status": status})
    print(json.dumps({"accepted": not failed, "checks": results}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
