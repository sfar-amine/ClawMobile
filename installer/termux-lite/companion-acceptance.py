#!/usr/bin/env python3
"""Post-deploy acceptance of the loopback Companion: every owner route must answer within its budget,
refuse what it must refuse, and never return secret-shaped content. Reads and non-owner refusal probes only: no authorized mutation is sent.

Exit 0 = accepted, 1 = regression (the deploy script rolls back), 2 = usage error.
A route that is not present in this build (404) is skipped, so the same check serves every release."""
import json, pathlib, re, sys, time, urllib.error, urllib.request
import ast, fcntl, hashlib, heapq, math, os, stat, subprocess, tempfile, uuid

BASE = "http://127.0.0.1:8765/v1"
# (path, budget seconds). Existing budgets were measured on S24; R8 user28 targets are locally tested and still require live qualification. A cold first read gets one retry.
READS = [
    ("/lighting/discover", 3.0),
    ("/lighting/d073d5225b23/state", 3.0),
    ("/lighting/d073d5225b23/diagnostics", 3.0),
    ("/catalog", 0.3), # HS2: warm reads from memory; one HS1 generation is ≈ 360 ms on the S24, so the cold first read uses the retry.
    ("/health", 2.0),
    # R22 real non-sensitive Context Sync job (fixture PR82); absent jobs are skipped.
    ("/automations/d1d0e51c-6815-4e7a-8eda-c7302bab8118/runs?limit=20", 6.0),
    ("/control/health?contract=2", 2.0),
    # R20 file reads (owner Gateway, deferred while warming; settle() judges them).
    ("/files?scope=agent", 1.5),
    ("/files?scope=session", 1.5),
    ("/files/content?scope=agent&path=AGENTS.md", 2.0),
    ("/files/content?scope=session&path=IDENTITY.md", 2.0),
    ("/usage", 6.0),
    ("/usage?details=cost", 12.0),
    ("/providers", 6.0),
    ("/whatsapp/allowlist", 10.0),
    ("/whatsapp/allowlist/history?limit=50", 10.0),
    ("/security/surfaces", 1.5),
    ("/notifications/sources", 6.0),
    ("/runs?limit=50", 4.0),
    ("/runs?limit=40&summary=1", 1.0),  # F4 : écran Notifications (80 ms capturés), projection structurée
    ("/runs?contract=2&view=conversations&limit=20", 0.3),
    # E4: archived subset of the same local projection, read warm after its sibling (never the first cold read).
    ("/runs?contract=2&view=conversations&archived=1&limit=20", 0.3),
    ("/control/deploys?limit=20", 0.5),
    ("/control/engineering?limit=20", 2.0),
    ("/control/diagnostic/export", 3.0),
    ("/updates", 4.0),
    ("/control/memory?limit=20", 3.0),
    ("/agent/config", 9.0),
    ("/laptop-access/computers", 6.0),
    # P1 : état d'enrôlement de l'admission native (lecture d'un fichier local, aucune clé privée).
    ("/owner-admission", 0.5),
    ("/security/surfaces", 2.0),
    # R8 user28 budgets; real recording volume is zero (captured producer forms are mock traces).
    ("/skills/candidates?limit=50", 1.5),
    ("/voice/voices", 1.0),
    ("/control/automations?contract=2", 1.0),
    # P2-b: an installed workspace skill on the S24 (fixtures/s24-2026-10-10/gateway/skills.status.json).
    # The Gateway wait is capped at 3 s (then partial); skills.status measured 1.8-2.4 s.
    ("/skills/clawmobile-capabilities", 4.0),
    # 38 A2 : projection owner d'improvements.db (engineering.learning_gate), cache court 5 s.
    ("/learning/associations?limit=20", 0.5),
]
# Mutations sent WITHOUT the owner header must be refused before any effect.
OWNER_GUARDS = [
    ("POST", "/lighting/d073d5225b23/state"),
    ("POST", "/conversations/acceptance-probe/archive"),
    ("POST", "/conversations/acceptance-probe/unarchive"),
    ("POST", "/attachments"),
    ("POST", "/security/surfaces"),
    ("POST", "/automations/acceptance-probe/run"),
    ("PATCH", "/automations/acceptance-probe"),  # R23 / E1 : modification refusée sans en-tête propriétaire, avant toute lecture
    ("POST", "/control/requests/REQ-0/cancel"),
    ("POST", "/agent/config"),
    ("POST", "/conversations/x/metadata"),
    ("POST", "/skills/learn"),
    ("POST", "/control/memory/import/preview"),
    ("POST", "/control/memory/import"),
    ("POST", "/control/memory/" + "a" * 64 + "/forget"),
    ("POST", "/runs/acceptance-probe/approval"),
    # 38 A2 : oublier et « Ce n'est pas ça » refusés sans en-tête propriétaire, avant tout effet.
    ("POST", "/learning/associations/" + "a" * 64 + "/forget"),
    ("POST", "/learning/not-this"),
    ("POST", "/whatsapp/allowlist"),
    ("POST", "/skills/clawmobile-capabilities/disable"),
    ("POST", "/skills/clawmobile-capabilities/enable"),
    ("POST", "/skills/clawmobile-capabilities/try"),
    ("POST", "/files"),
    ("POST", "/files/content"),
    ("PUT", "/files/content?scope=agent&path=AGENTS.md"),  # E3 : écriture refusée sans en-tête propriétaire, avant toute lecture
    # Lot paiement Maxit 11/10 (P1-5): these routes changed budget (Payment Core quote 45 s,
    # local start = quote 45 s + execution 230 s, resume 65 s). Acceptance never sends an authorized
    # payment mutation: without the native owner header they must be refused before any effect.
    # P1 : enrôlement et révocation de l'admission native refusés sans en-tête propriétaire (et sans biométrie/preuve signée).
    ("POST", "/owner-admission/enrollment"),
    ("DELETE", "/owner-admission/enrollment"),
    ("POST", "/extensions/claw-live/capability"),  # P1: no signed admission, no voice effect
    ("POST", "/payments/local-handoffs"),
    ("POST", "/payments/local-start"),
    ("POST", "/payments/" + "1" * 8 + "-1111-4111-8111-" + "1" * 12 + "/bank-return"),
]
OWNER_GUARD_BUDGETS = {"/skills/learn": 2.0, "/payments/local-handoffs": 2.0, "/payments/local-start": 2.0, "/conversations/acceptance-probe/archive": 2.0, "/conversations/acceptance-probe/unarchive": 2.0}  # admission/refusal budget, no effect without owner proof
# Short-cache reads (cache shorter than RETRY_PAUSE_S, so the retry is cold too): prewarmed untimed, like /catalog.
PREWARM = {"/control/automations?contract=2", "/learning/associations?limit=20"}
SETTLE_SECONDS = 15
# O9 (fichier 37): a voice run whose transcript is final (completed/interrupted) is never state=unknown.
VOICE_TERMINAL_ROUTE = "/runs?limit=50"


def voice_terminal_unknown(body):
    """Read-only invariant on the already fetched run list: ids of voice runs left unknown with a final transcript."""
    try:
        listed = json.loads(body or b"{}").get("runs")
    except (ValueError, AttributeError):
        return None
    if not isinstance(listed, list):
        return None
    return [str(run.get("runId"))[:80] for run in listed if isinstance(run, dict) and run.get("modality") == "voice"
            and run.get("transcriptState") in ("completed", "interrupted") and run.get("state") == "unknown"]
# HS8 (17/10): the composer microphone is announced by /catalog inputs.voiceMemo, gated by the S24 qualification receipt.
def voice_memo_input(body):
    """Read-only check on the already fetched catalog: True/False when inputs.voiceMemo is a coherent
    {available, availability} object, "absent" for a body without it (older build), None when it is
    malformed (the app would mis-render the microphone)."""
    try:
        inputs = json.loads(body or b"{}").get("inputs")
        if inputs is None:
            return "absent"
        memo = inputs.get("voiceMemo")
    except (ValueError, AttributeError):
        return None
    if not isinstance(memo, dict) or not isinstance(memo.get("available"), bool):
        return None
    expected = "available" if memo["available"] else "soon"
    return memo["available"] if memo.get("availability") == expected else None
# Secrets and account e-mails. 10/10 (recette UI): /agent/config published the OAuth profile e-mail.
# Measured read-only on the S24 the same day: no other READS route returns an e-mail address.
LEAK = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|refresh_token|access_token|-----BEGIN [A-Z ]*PRIVATE KEY")
# An e-mail address is reported as a warning, never a failure: it must not roll a deploy back (Amine, 10/10).
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}")


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


# Pause between readings of a failed check (budget overrun, 5xx or timeout). #355: at most three readings (about
# 30 s with the pauses), so a single sample taken during the gateway restart never decides a rollback.
RETRY_PAUSE_S = float(__import__("os").environ.get("COMPANION_ACCEPT_RETRY_PAUSE_S", "8"))
ATTEMPTS = 3


def transient(code):
    """A reading that a restart or a load spike explains: timeout (0) or 5xx. Anything else is a verdict."""
    return code == 0 or 500 <= code <= 599


def load_baseline(path):
    """Read the previous deployment receipt. Old receipts remain valid and simply have no comparison."""
    if not path:
        return {}
    try:
        doc = json.loads(pathlib.Path(path).read_text())
        value = doc.get("acceptance", doc)
        if isinstance(value, str):
            value = json.loads(value)
        rows = value.get("checks") if isinstance(value, dict) else None
        return {row["route"]: float(row["seconds"]) for row in rows or []
                if isinstance(row, dict) and isinstance(row.get("route"), str)
                and isinstance(row.get("seconds"), (int, float)) and not row.get("read") and not row.get("check")}
    except (OSError, ValueError, TypeError):
        return {}


def timing_result(path, took, budget, baseline):
    """Reject a material slowdown, while treating restart jitter as variance.

    The fixed budget remains the fallback for a first deployment. With a previous receipt, a reading over
    budget is a regression only when it is also over the previous release by 50% and at least 0.5 s.
    This accepts the observed 9.00 -> 9.44 s jitter and catches a simulated 2 -> 10 s Gateway slowdown.
    """
    previous = baseline.get(path)
    regression = took > budget if previous is None else took > budget and took > previous + max(0.5, previous * 0.5)
    return not regression, previous, regression


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


def owner_transport_unavailable(body):
    """Nombre de runs récents dont l'admission native était valide mais la connexion admin indisponible."""
    try:
        runs = json.loads(body).get("runs")
    except (ValueError, AttributeError):
        return 0
    return sum(1 for run in runs if isinstance(run, dict) and run.get("ownerTransport") == "write_cli_owner_unavailable") if isinstance(runs, list) else 0


def main(session_id=None, baseline_path=None):
    if session_id is not None and (not isinstance(session_id,str) or not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*",session_id) or len(session_id)>80):
        return 2
    results, failed, candidate_id, conversation_id = [], False, None, session_id
    baseline = load_baseline(baseline_path)
    warnings = []
    # HS1 builds the catalog lazily. Trigger exactly one generation before the timed /catalog row so a cold
    # restart is not judged as a code regression. Focused acceptance tests may intentionally omit this route.
    if any(path == "/catalog" for path, _ in READS):
        for warm_attempt in range(3):
            warm_code, _, warm_seconds = call("GET", "/catalog", 15)
            if warm_code in (200, 404):
                break
            if warm_attempt < 2:
                time.sleep(2)
        warm_status = "ok" if warm_code == 200 else ("skipped" if warm_code == 404 else "fail")
        failed |= warm_status == "fail"
        results.append({"route": "/catalog", "check": "prewarm", "code": warm_code,
                        "seconds": round(warm_seconds, 2), "status": warm_status})
    def metadata_checks(identifier):
        nonlocal failed
        for label,budget in (("cold",6.0),("warm",1.5)):
            if identifier is not None:
                for attempt in (1, 2):
                    code, body, took = call("GET", "/conversations/" + identifier + "/metadata", budget + 1)
                    if (code == 200 and took <= budget) or code == 404 or attempt == 2:
                        break
                    time.sleep(RETRY_PAUSE_S)
                leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
                status = "skipped" if code == 404 else ("ok" if code == 200 and took <= budget and not leak else "fail")
            else:
                code, took, leak, status = None, 0, False, "skipped"
            failed |= status == "fail"
            results.append({"route": "/conversations/{sessionId}/metadata", "read":label,"code": code, "seconds": round(took, 2), "budget": budget, "leak": leak, "status": status})
    if session_id is not None:
        metadata_checks(session_id)
    for path, budget in READS:
        if path in PREWARM:
            # Same rule as /catalog: one untimed read right before the timed row, so a cold restart (empty short
            # cache, first collection) is not judged as a code regression. S24 17/10: rolled back on these two rows.
            # #355 (S24 18/10 17:59): a prewarm 504 right after the gateway restart rolled back a text-only release.
            # A 5xx or a timeout is read again (bounded); only a repeated one, or any other code, fails.
            warm_samples = []
            for warm_attempt in range(1, ATTEMPTS + 1):
                warm_code, _, warm_seconds = call("GET", path, budget + 10)
                warm_samples.append({"code": warm_code, "seconds": round(warm_seconds, 2)})
                if not transient(warm_code) or warm_attempt == ATTEMPTS:
                    break
                time.sleep(RETRY_PAUSE_S)
            warm_status = "ok" if warm_code == 200 else ("skipped" if warm_code == 404 else "fail")
            failed |= warm_status == "fail"
            results.append({"route": path, "check": "prewarm", "code": warm_code,
                            "seconds": round(warm_seconds, 2), "samples": warm_samples, "status": warm_status})
        samples = []
        for attempt in range(1, ATTEMPTS + 1):
            code, body, took = call("GET", path, budget + 5)
            timing_ok, previous_seconds, regression = timing_result(path, took, budget, baseline)
            ok = code == 200 and timing_ok
            leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
            samples.append({"code": code, "seconds": round(took, 2)})
            # A leak is never re-read; a slow or 5xx reading is, after a pause (retro 12/10, #355: up to three
            # readings, the decision is taken on the repeated result, budgets unchanged).
            if ok or leak or code == 404 or attempt == ATTEMPTS or not (transient(code) or (code == 200 and not timing_ok)):
                break
            time.sleep(RETRY_PAUSE_S)
        settled = settle(path, body) if code == 200 else True
        if code == 200 and EMAIL.search(body.decode("utf-8", "replace")):
            warnings.append({"route": path, "warning": "email_address_in_response"})
        status = "skipped" if code == 404 else ("ok" if ok and not leak and settled else "fail")
        failed |= status == "fail"
        results.append({"route": path, "code": code, "seconds": round(took, 2), "budget": budget,
                        "previousSeconds": previous_seconds, "regression": regression,
                        "leak": leak, "settled": settled, "samples": samples, "status": status})
        if path == "/catalog" and code == 200:
            memo = voice_memo_input(body)
            # Malformed = regression; a closed (qualification refused) microphone is reported, never a rollback by itself.
            memo_status = "skipped" if memo == "absent" else ("fail" if memo is None else "ok")
            failed |= memo_status == "fail"
            results.append({"route": path, "check": "voice_memo_input", "available": memo if isinstance(memo, bool) else None, "status": memo_status})
            if memo is False:
                warnings.append({"route": path, "warning": "voice_memo_unavailable"})
        if path == VOICE_TERMINAL_ROUTE and code == 200:
            stale = voice_terminal_unknown(body)
            # No run list to judge (route shape owned by its READS row): skipped, never a rollback by itself.
            voice_status = "skipped" if stale is None else ("ok" if stale == [] else "fail")
            failed |= voice_status == "fail"
            results.append({"route": path, "check": "voice_runs_terminal_state", "unknown_terminal": len(stale) if stale is not None else None, "status": voice_status})
        if path == VOICE_TERMINAL_ROUTE and code == 200:
            # P1 : un tour admis owner parti sur le CLI write (SDK OpenClaw absent ou version différente) est une alerte,
            # pas un retour arrière : il est resté non-owner (refus fermé), mais l'autorité d'Amine ne passe plus.
            degraded = owner_transport_unavailable(body)
            if degraded:
                warnings.append({"route": path, "warning": "owner_transport_unavailable", "runs": degraded})
        if path == "/runs?contract=2&view=conversations&limit=20" and code == 200 and conversation_id is None:
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
    # Use a real retained conversation, never a fabricated owner session.
    if session_id is None:
        metadata_checks(conversation_id)
    # Exercise the detail only with an existing owner artifact, never a fabricated trace.
    if candidate_id is not None:
        budget = 1.0  # user28 detail-read budget
        path = "/skills/candidates/" + candidate_id
        code, body, took = call("GET", path, budget + 5)
        leak = bool(LEAK.search(body.decode("utf-8", "replace"))) if code == 200 else False
        status = "ok" if code == 200 and took <= budget and not leak else "fail"
        failed |= status == "fail"
        results.append({"route": "/skills/candidates/{traceId}", "code": code, "seconds": round(took, 2), "budget": budget, "leak": leak, "status": status})
    # R20: judge leaks on the settled file answer, never on the "warming" placeholder.
    for row in results:
        if row["route"].startswith("/files") and row["status"] == "ok":
            code, body, _ = call("GET", row["route"], row["budget"] + 5)
            if code == 200 and LEAK.search(body.decode("utf-8", "replace")):
                row["leak"], row["status"] = True, "fail"
                failed = True
    for method, path in OWNER_GUARDS:
        budget = OWNER_GUARD_BUDGETS.get(path, 10.0)
        code, _, took = call(method, path, budget)
        # The metadata guard runs before any lookup: a present route must answer 403, an absent one (404) is skipped.
        refused = code == 403 if path == "/conversations/x/metadata" else code in (400, 403, 405)
        status = "skipped" if code == 404 else ("ok" if refused and took <= budget else "fail")
        failed |= status == "fail"
        results.append({"route": method + " " + path + " (no owner header)", "code": code, "seconds": round(took, 2), "budget": budget, "status": status})
    print(json.dumps({"accepted": not failed, "checks": results, "warnings": warnings}, ensure_ascii=False))
    return 1 if failed else 0


# F5.3: optional, explicit human-gesture receipt in the existing deployment owner.
# Default route acceptance above, including every payment refusal probe, is unchanged.
WEB_RECIPE_ID = re.compile(r"[0-9]{13}-[a-f0-9]{16}\Z")
WEB_OPAQUE_ID = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")
WEB_RECIPE_LIMIT = 64 * 1024
WEB_RECIPE_KEEP = 30


def web_static_constants(path, names):
    tree = ast.parse(path.read_text())
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in names:
                    value = ast.literal_eval(node.value)
                    if type(value) is not int or value <= 0 or target.id in found:
                        raise ValueError("web_budget_contract_invalid")
                    found[target.id] = value
    if set(found) != set(names):
        raise ValueError("web_budget_contract_unavailable")
    return found


def web_recipe_contract(core, playbooks):
    # Explicit owner roots: never guess a release, install a copy or execute inspected Python.
    core, playbooks = pathlib.Path(core).resolve(), pathlib.Path(playbooks).resolve()
    helper = core / "installer/termux-lite/model-fast-path.py"
    owner = playbooks / "skill_intelligence/public_web.py"
    validator = core / "openclaw-plugin-mobile-ui/dist/companion/runWeb.js"
    try:
        total = web_static_constants(helper, {"PUBLIC_WEB_BUDGET_MS"})["PUBLIC_WEB_BUDGET_MS"]
        values = web_static_constants(owner, {"BUDGET_MS", "SEARCH_BUDGET_MS"})
        if total != values["BUDGET_MS"] or values["SEARCH_BUDGET_MS"] > total:
            raise ValueError("web_budget_contract_differs")
        digests = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                   for name, path in (("core", helper), ("playbooks", owner), ("validator", validator))}
        return {"totalMs": total, "searchMs": values["SEARCH_BUDGET_MS"], "digests": digests}, validator
    except (OSError, SyntaxError, TypeError):
        raise ValueError("web_budget_contract_unavailable") from None


def web_contract_valid(web, validator):
    # The existing TypeScript owner validates claims/sources/citations; no duplicate schema here.
    script = "const fs=require('fs');const v=require(process.argv[1]);let ok=false;try{ok=!!v.readRunWebResult(JSON.parse(fs.readFileSync(0,'utf8')))}catch{};process.stdout.write(ok?'valid':'invalid');"
    try:
        result = subprocess.run(["node", "-e", script, str(validator)], input=json.dumps(web, allow_nan=False),
                                text=True, capture_output=True, timeout=3, check=False)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ValueError("web_contract_validator_unavailable") from None
    if result.returncode != 0:
        raise ValueError("web_contract_validator_unavailable")
    return result.stdout == "valid"


def web_recipe_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > WEB_RECIPE_LIMIT:
            raise ValueError("web_recipe_invalid")
        row = json.load(stream)
    if not isinstance(row, dict) or row.get("kind") != "web_gesture_acceptance" or row.get("version") != 1:
        raise ValueError("web_recipe_invalid")
    return row


def web_recipe_write(path, row):
    data = (json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n").encode()
    if len(data) > WEB_RECIPE_LIMIT or path.is_symlink():
        raise ValueError("web_recipe_invalid")
    fd, tmp = tempfile.mkstemp(prefix=".web-recipe-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.chmod(tmp, 0o600); os.replace(tmp, path)
    finally:
        pathlib.Path(tmp).unlink(missing_ok=True)
    # Only this optional acceptance's receipts, never deploy/rollback/payment proof or unknown files.
    def receipts():
        for candidate in path.parent.glob("web-recipe-*.json"):
            if not WEB_RECIPE_ID.fullmatch(candidate.name[len("web-recipe-"):-5]) or candidate.is_symlink() or not candidate.is_file():
                continue
            try:
                web_recipe_read(candidate)
                yield candidate
            except (OSError, ValueError):
                continue
    keep = {p.name for p in heapq.nlargest(WEB_RECIPE_KEEP, receipts(), key=lambda p: p.name)}
    for old in receipts():
        if old.name not in keep:
            old.unlink(missing_ok=True)


def web_recipe_judgment(prepared, run, run_id, now, contract, validator):
    result = {"runId": run_id, "state": "failed", "reason": "web_run_unavailable"}
    if not isinstance(run, dict):
        return result
    reason = run.get("reasonClass")
    if isinstance(reason, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,95}", reason):
        result["reasonClass"] = reason
    if run.get("runId") != run_id or run.get("sessionId") != prepared.get("sessionId"):
        return {**result, "reason": "web_run_identity_mismatch"}
    client = run.get("clientRunId")
    if not isinstance(client, str) or not WEB_OPAQUE_ID.fullmatch(client) or (prepared.get("clientRunId") and client != prepared["clientRunId"]):
        return {**result, "reason": "web_run_identity_mismatch"}
    result["clientRunId"] = client
    start, end = run.get("submittedAt"), run.get("updatedAt")
    if (type(start) is not int or type(end) is not int or not prepared["preparedAtMs"] <= start <= end <= now):
        return {**result, "reason": "web_run_outside_prepared_window"}
    if run.get("state") not in ("done", "failed"):
        return {**result, "reason": "web_run_not_terminal"}
    web = run.get("web")
    if not isinstance(web, dict) or not web_contract_valid(web, validator):
        return {**result, "reason": "web_contract_invalid"}
    if web.get("operation") != prepared["operation"]:
        return {**result, "reason": "web_operation_mismatch"}
    metrics = web.get("metrics") or {}
    measured = {"elapsedMs": end - start}
    for key in ("searchMs", "fetchMs", "synthesisMs", "totalMs", "logicalSearchCalls", "fetchCount", "providerAttempts"):
        value = metrics.get(key)
        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
            measured[key] = value
    result.update({"operation": web["operation"], "outcome": web["outcome"], "metrics": measured,
                   "sourceCount": len(web["sources"]), "claimCount": len(web["claims"]), "citationCount": len(web["citations"])})
    error = web.get("error")
    if error:
        return {**result, "reason": error["code"], "stage": error["stage"]}
    if web["outcome"] != "complete" or run["state"] != "done":
        return {**result, "reason": "web_run_incomplete"}
    if "searchMs" not in measured:
        return {**result, "reason": "web_timing_unavailable"}
    if measured["searchMs"] > contract["searchMs"] or max(measured["elapsedMs"], measured.get("totalMs", 0)) > contract["totalMs"]:
        return {**result, "reason": "web_deadline_exceeded"}
    return {**result, "state": "passed", "reason": "web_run_verified"}


def web_recipe(mode, session_id, core_root, playbooks_root, recipe_id=None, run_id=None,
               operation="answer", client_run_id=None, home=None, clock=None, reader=None):
    """Prepare before Amine's gesture; judge one explicitly identified existing run, with GET only."""
    now = int((clock or time.time)() * 1000)
    if not core_root or not playbooks_root:
        raise ValueError("web_owner_roots_required")
    if mode == "prepare" and (not isinstance(session_id, str) or not WEB_OPAQUE_ID.fullmatch(session_id)
        or operation not in ("search", "answer") or client_run_id is not None and not WEB_OPAQUE_ID.fullmatch(client_run_id)):
        raise ValueError("web_recipe_identity_invalid")
    if mode == "judge" and (not isinstance(recipe_id, str) or not WEB_RECIPE_ID.fullmatch(recipe_id)
        or not isinstance(run_id, str) or not WEB_OPAQUE_ID.fullmatch(run_id)):
        raise ValueError("web_recipe_identity_invalid")
    contract, validator = web_recipe_contract(core_root, playbooks_root)
    directory = pathlib.Path(home or pathlib.Path.home()) / ".openclaw/deploys"
    directory.mkdir(parents=True, exist_ok=True)
    # Same existing deployment lock; held only for this bounded preparation or reading, never during the gesture.
    with open(directory / "companion-deploy.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("web_recipe_deployment_busy") from None
        if mode == "prepare":
            recipe_id = str(now) + "-" + uuid.uuid4().hex[:16]
            row = {"version": 1, "kind": "web_gesture_acceptance", "state": "prepared", "recipeId": recipe_id,
                   "preparedAtMs": now, "sessionId": session_id, "operation": operation, "contract": contract}
            if client_run_id is not None:
                row["clientRunId"] = client_run_id
        elif mode == "judge":
            row = web_recipe_read(directory / ("web-recipe-" + recipe_id + ".json"))
            if row.get("recipeId") != recipe_id or row.get("state") not in ("prepared", "passed", "failed"):
                raise ValueError("web_recipe_invalid")
            if row["state"] != "prepared":
                if row.get("judgment", {}).get("runId") != run_id:
                    raise ValueError("web_recipe_already_judged")
                return {"recipeId": recipe_id, "state": row["state"], "judgment": row["judgment"]}, 0 if row["state"] == "passed" else 1
            if row.get("contract") != contract:
                raise ValueError("web_budget_contract_changed")
            code, body, _ = (reader or call)("GET", "/runs/" + run_id, dict(READS)["/runs?limit=50"])
            if code != 200:
                judgment = {"runId": run_id, "state": "failed", "reason": "web_run_http_unavailable",
                            "httpStatus": code if type(code) is int and 0 <= code <= 599 else 0}
            else:
                try:
                    run = json.loads(body)
                    judgment = web_recipe_judgment(row, run, run_id, now, contract, validator)
                except (ValueError, TypeError) as error:
                    if str(error).startswith("web_contract_validator_"):
                        raise
                    judgment = {"runId": run_id, "state": "failed", "reason": "web_run_response_invalid"}
            row.update({"state": judgment["state"], "judgedAtMs": now, "judgment": judgment})
        else:
            raise ValueError("web_recipe_mode_invalid")
        path = directory / ("web-recipe-" + recipe_id + ".json")
        web_recipe_write(path, row)
        return {"recipeId": recipe_id, "state": row["state"], "receipt": path.name,
                **({"judgment": row["judgment"]} if "judgment" in row else {})}, 0 if row["state"] in ("prepared", "passed") else 1


if __name__ == "__main__":
    import argparse
    parser=argparse.ArgumentParser(description="Read-only Companion acceptance; session supplied by Claude for metadata budgets")
    parser.add_argument("--session-id")
    parser.add_argument("--baseline", help="previous deployment receipt whose acceptance timings are the comparison")
    parser.add_argument("--web-recipe", choices=("prepare", "judge"))
    parser.add_argument("--web-core-root")
    parser.add_argument("--playbooks-root")
    parser.add_argument("--web-recipe-id")
    parser.add_argument("--web-run-id")
    parser.add_argument("--web-client-run-id")
    parser.add_argument("--web-operation", choices=("search", "answer"), default="answer")
    args=parser.parse_args()
    if args.web_recipe:
        try:
            output, code = web_recipe(args.web_recipe, args.session_id, args.web_core_root, args.playbooks_root,
                                      args.web_recipe_id, args.web_run_id, args.web_operation, args.web_client_run_id)
        except (OSError, ValueError, TypeError, KeyError) as error:
            reason = str(error) if isinstance(error, ValueError) and re.fullmatch(r"web_[a-z_]+", str(error)) else "web_recipe_unavailable"
            output, code = {"state": "failed", "reason": reason}, 2
        print(json.dumps(output)); sys.exit(code)
    sys.exit(main(args.session_id, args.baseline))
