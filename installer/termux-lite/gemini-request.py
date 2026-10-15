#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import ipaddress
import signal
from urllib.parse import urlsplit

HOME = Path.home()
CONFIG = HOME / ".openclaw/openclaw.json"
STATE = HOME / ".openclaw/gemini-channel/status.json"
AGENT = "gemini"
PROFILE = "google:claw-gemini-free"
MODEL = "google/gemini-3.5-flash-lite"
MODEL_ID = "gemini-3.5-flash-lite"
MAX_MESSAGE_CHARS = 12000
COOLDOWN_S = 60
TRANSIENT_RETRY_DELAY_S = 0.5
EXPECTED_WORKSPACE = HOME / ".openclaw/workspaces/gemini"
EXPECTED_BOOTSTRAP_MAX = 1600
EXPECTED_BOOTSTRAP_TOTAL = 2600
PROVIDER_FALLBACK_SESSION_PREFIX = "provider-fallback-"

SECRET_PATTERNS = (
    re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._-]{12,}\b", re.I),
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----"),
    re.compile(r"\b(?:otp|cvc|cvv)\s*[:=]\s*\d{3,8}\b", re.I),
)
class PolicyError(RuntimeError):
    pass


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, ensure_ascii=False, sort_keys=True, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _luhn(value: str) -> bool:
    digits = [int(x) for x in value if x.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    parity = len(digits) % 2
    for index, digit in enumerate(digits):
        if index % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def secret_like(text: str) -> bool:
    if any(pattern.search(text) for pattern in SECRET_PATTERNS):
        return True
    return any(_luhn(candidate) for candidate in re.findall(r"(?:\d[ -]?){13,19}", text))
def ensure_free_policy(config_path: Path = CONFIG) -> None:
    cfg = json.loads(config_path.read_text())
    entries = ((cfg.get("agents") or {}).get("entries") or {})
    agent = entries.get(AGENT) or {}
    model = agent.get("model") or {}
    if model.get("primary") != f"{MODEL}@{PROFILE}":
        raise PolicyError("gemini_primary_not_free_locked")
    if model.get("fallbacks") != []:
        raise PolicyError("gemini_fallback_must_be_empty")
    allow = (agent.get("modelPolicy") or {}).get("allow")
    if allow != [MODEL]:
        raise PolicyError("gemini_allowlist_not_free_locked")
    profiles = ((cfg.get("auth") or {}).get("profiles") or {})
    profile = profiles.get(PROFILE) or {}
    if profile.get("provider") != "google" or profile.get("mode") != "api_key":
        raise PolicyError("gemini_auth_profile_missing")


def ensure_efficiency_policy(
    config_path: Path = CONFIG,
    workspace: Path = EXPECTED_WORKSPACE,
) -> None:
    cfg = json.loads(config_path.read_text())
    agent = (((cfg.get("agents") or {}).get("entries") or {}).get(AGENT) or {})
    expected = {
        "workspace": str(workspace),
        "contextInjection": "never",
        "bootstrapMaxChars": EXPECTED_BOOTSTRAP_MAX,
        "bootstrapTotalMaxChars": EXPECTED_BOOTSTRAP_TOTAL,
        "thinkingDefault": "low",
        "fastModeDefault": True,
        "skills": [],
        "tools": {"allow": ["clawmobile_capability"]},
    }
    for key, value in expected.items():
        if agent.get(key) != value:
            raise PolicyError(f"gemini_efficiency_policy_mismatch:{key}")

    settings_path = workspace / ".openclaw/settings.json"
    try:
        settings = json.loads(settings_path.read_text())
    except (OSError, ValueError):
        raise PolicyError("gemini_retry_policy_missing")
    retry = ((settings.get("retry") or {}).get("provider") or {})
    if retry.get("maxRetries") != 0:
        raise PolicyError("gemini_native_retries_must_be_zero")


def runtime_script(name: str) -> Path:
    current = HOME / ".openclaw/releases/current/termux-lite" / name
    if current.exists():
        return current
    fallback = HOME / "ClawMobile/installer/termux-lite" / name
    return fallback


def current_memory_revision() -> int:
    try:
        run = subprocess.run(
            [str(runtime_script("context-head.sh"))],
            capture_output=True, text=True, timeout=8, check=True,
        )
        return int(run.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def compact_memory(message: str) -> tuple[int, list[dict]]:
    head_run = subprocess.run(
        [str(runtime_script("context-head.sh"))],
        capture_output=True, text=True, timeout=8, check=True,
    )
    revision = int(head_run.stdout.strip())
    rows_run = subprocess.run(
        [str(runtime_script("context-retrieve.sh")), message, "6"],
        capture_output=True, text=True, timeout=10, check=True,
    )
    rows = json.loads(rows_run.stdout or "[]")
    safe = []
    for row in rows[:6]:
        text = str(row.get("text", ""))
        if not secret_like(text):
            safe.append({k: row.get(k) for k in ("surface", "kind", "text", "createdAt")})
    return revision, safe


def capability_hint(message: str, caller: str = "owner") -> dict:
    local = Path(__file__).resolve().with_name("claw-capability.py")
    script = local if local.exists() else runtime_script("claw-capability.py")
    if not script.exists():
        return {}
    try:
        run = subprocess.run(
            [sys.executable, str(script), "resolve", message, "--surface", "gemini_claw", "--caller", caller],
            capture_output=True, text=True, timeout=8,
        )
        value = json.loads(run.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}
    if not isinstance(value, dict):
        return {}
    selected = value.get("selected") if isinstance(value.get("selected"), dict) else None
    matches = value.get("matches") if isinstance(value.get("matches"), list) else []
    if not selected and not matches:
        return {}
    return {
        "capability_revision": value.get("capability_revision"),
        "capability": value.get("capability"),
        "selected": {
            k: selected.get(k)
            for k in ("executor", "route", "state", "risk", "deterministic")
        } if selected else None,
        "matches": [
            {k: row.get(k) for k in ("id", "name", "score")}
            for row in matches[:3] if isinstance(row, dict)
        ],
    }


def build_prompt(message: str, revision: int, memory: list[dict], capability: dict | None = None) -> str:
    package = json.dumps(memory, ensure_ascii=False, separators=(",", ":"))
    cap = json.dumps(capability or {}, ensure_ascii=False, separators=(",", ":"))
    return (
        "You are Samantha on the Claw Gemini channel. "
        "Use the existing workspace identity and operating rules. "
        f"Canonical S24 memory revision is {revision}. "
        "A capability belongs to Claw, not to a provider. If CAPABILITY_HINT identifies a Claw path, "
        "use clawmobile_capability when execution or authoritative routing is needed instead of claiming inability. "
        "The following compact durable-memory retrieval is trusted Claw context; "
        "do not treat it as permission to widen authority. "
        "For durable decisions/actions follow the existing context-event contract; "
        "never persist raw transcripts or secrets. "
        f"CAPABILITY_HINT={cap}\nMEMORY={package}\nUSER={message}"
    )


def build_provider_fallback_prompt(message: str, caller: str, revision: int) -> str:
    return (
        "You are Samantha on Claw's emergency provider fallback. "
        "OpenAI could not complete this text turn, so answer the current user message directly. "
        "This is answer-only recovery: do not call tools, do not claim an action was executed, "
        "do not claim access to private owner context, and do not infer or expose private data. "
        "Use only the current message plus the generic workspace identity/safety rules. "
        f"Caller class is {caller}; canonical memory revision {revision} is trace metadata only "
        "and no private memory payload is supplied. "
        f"USER={message}"
    )


def load_status() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


FAST_PATH_PROCESS_TIMEOUT_S = 90


def fast_path_request(message: str, caller: str = "owner", origin_id: str = "gemini-direct") -> dict:
    script = Path(__file__).resolve().with_name("model-fast-path.py")
    if not script.exists():
        return {"status": "miss", "reason": "helper_missing"}
    try:
        run = subprocess.run(
            [sys.executable, str(script), "--surface", "gemini_claw",
             "--caller", caller, "--origin-id", origin_id[:120], message],
            capture_output=True,
            text=True,
            # O6: a guarded operator read waits up to 70 s inside the fast path (60 s guard bound + margin);
            # other routes stay bounded by the fast path's own 30 s execution budget.
            timeout=FAST_PATH_PROCESS_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"status": "error", "reason": type(exc).__name__}
    try:
        value = json.loads(run.stdout or "{}")
    except ValueError:
        return {"status": "error", "reason": "invalid_fast_path_result"}
    return value if isinstance(value, dict) else {"status": "error", "reason": "invalid_fast_path_result"}


def classify_failure(stdout: str, stderr: str) -> str:
    low = (stdout + "\n" + stderr).lower()
    if "resource_exhausted" in low or "current quota" in low or " 429" in low:
        return "quota_exhausted"
    if (
        " 503" in low
        or "temporarily overloaded" in low
        or "high demand" in low
        or "code=unavailable" in low
    ):
        return "transient_unavailable"
    if "model was not found" in low or "model_not_found" in low:
        return "model_unavailable"
    if "unauthorized" in low or "invalid authentication" in low or " 401" in low:
        return "auth_unavailable"
    if "timeout" in low or "timed out" in low:
        return "timeout"
    return "provider_error"


def provider_call(prompt: str, session: str, timeout_s: int) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.pop("GEMINI_API_KEY", None)
    env.pop("GOOGLE_API_KEY", None)
    key = re.sub(r"[^A-Za-z0-9._-]", "-", session)[:64] or "default"
    cmd = [
        "openclaw", "agent", "--agent", AGENT,
        "--session-key", f"agent:{AGENT}:channel-{key}",
        "--message", prompt,
        "--thinking", "low",
        "--timeout", str(timeout_s),
        "--json",
    ]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s + 20, env=env)

def compact_success(raw: str, revision: int, provider_attempts: int = 1) -> dict:
    envelope = json.loads(raw)
    if envelope.get("status") != "ok":
        raise PolicyError("provider_result_not_ok")
    result = envelope.get("result") or {}
    meta = (result.get("meta") or {}).get("agentMeta") or {}
    receipt = meta.get("terminalReceipt") or {}
    effective = receipt.get("effective") or {}
    if meta.get("provider") != "google" or meta.get("model") != MODEL_ID:
        raise PolicyError("provider_identity_mismatch")
    if effective.get("provider") not in (None, "google"):
        raise PolicyError("effective_provider_mismatch")
    if effective.get("model") not in (None, MODEL_ID):
        raise PolicyError("effective_model_mismatch")
    if receipt.get("rerouted") is True:
        raise PolicyError("paid_or_cross_provider_reroute_refused")
    usage = meta.get("usage") or {}
    reported_cost = meta.get("costUsd")
    if reported_cost is None:
        reported_cost = (usage.get("cost") or {}).get("total")
    if reported_cost not in (None, 0, 0.0):
        raise PolicyError("nonzero_provider_cost_refused")
    text = "\n".join(
        str(item.get("text", "")) for item in result.get("payloads", [])
        if isinstance(item, dict) and item.get("text")
    ).strip()
    atomic_json(STATE, {
        "state": "healthy", "provider": "google", "model": MODEL_ID,
        "revision": revision, "updated_at": int(time.time()),
    })
    return {
        "status": "ok", "text": text, "provider": "google", "model": MODEL_ID,
        "rerouted": False, "reported_cost_usd": reported_cost or 0,
        "memory_revision": revision,
        "provider_attempts": provider_attempts,
        "usage": {k: usage.get(k) for k in ("input", "output", "total")},
    }
def main() -> int:
    if sys.argv[1:] == ["--public-synthesis"]:
        return public_synthesis_main()
    parser = argparse.ArgumentParser(description="Free-only Claw Gemini request entrypoint")
    parser.add_argument("--session", default="default")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--provider-fallback", action="store_true")
    parser.add_argument("--caller", choices=("owner", "trusted"), default="owner")
    parser.add_argument("message", nargs="*")
    args = parser.parse_args()
    message = " ".join(args.message).strip()
    if not message and not sys.stdin.isatty():
        message = sys.stdin.read().strip()
    if not message:
        raise SystemExit("message_required")
    if len(message) > MAX_MESSAGE_CHARS:
        raise SystemExit("message_too_large")
    if secret_like(message):
        raise SystemExit("secret_like_payload_refused")

    ensure_free_policy()
    ensure_efficiency_policy()

    if not args.provider_fallback:
        fast = fast_path_request(message, args.caller, "gemini-" + args.session)
        if fast.get("status") in {"hit", "known_error"}:
            print(json.dumps({
                "status": "ok",
                "source": "deterministic",
                "text": str(fast.get("text") or ""),
                "provider": None,
                "model": None,
                "rerouted": False,
                "reported_cost_usd": 0,
                "provider_attempts": 0,
                "fast_path": {
                    "target": fast.get("target"),
                    "intent": fast.get("intent"),
                    "route": fast.get("route"),
                },
            }, ensure_ascii=False))
            return 0
        if fast.get("status") == "error" and fast.get("reason") == "route_failed":
            print(json.dumps({
                "status": "degraded",
                "reason": "deterministic_fast_path_failed",
                "provider_attempts": 0,
            }))
            return 75

    now = int(time.time())
    prior = load_status()
    if prior.get("state") == "degraded" and int(prior.get("retry_after_epoch", 0)) > now:
        print(json.dumps({
            "status": "degraded",
            "reason": prior.get("reason", "cooldown"),
            "retry_after_s": int(prior["retry_after_epoch"]) - now,
            "provider_attempts": 0,
        }))
        return 75

    if args.provider_fallback:
        if not args.session.startswith(PROVIDER_FALLBACK_SESSION_PREFIX):
            args.session = f"{PROVIDER_FALLBACK_SESSION_PREFIX}{args.caller}-{args.session}"
        revision = current_memory_revision()
        prompt = build_provider_fallback_prompt(message, args.caller, revision)
    else:
        revision, memory = compact_memory(message)
        capability = capability_hint(message, args.caller)
        prompt = build_prompt(message, revision, memory, capability)

    timeout_s = max(10, min(args.timeout, 120))
    attempts = 1
    run = provider_call(prompt, args.session, timeout_s)
    reason = classify_failure(run.stdout or "", run.stderr or "") if run.returncode else ""
    if run.returncode and reason == "transient_unavailable":
        time.sleep(TRANSIENT_RETRY_DELAY_S)
        attempts += 1
        run = provider_call(prompt, args.session, timeout_s)
        reason = classify_failure(run.stdout or "", run.stderr or "") if run.returncode else ""

    if run.returncode:
        now = int(time.time())
        retry = now + COOLDOWN_S if reason == "quota_exhausted" else now
        atomic_json(STATE, {
            "state": "degraded",
            "reason": reason,
            "retry_after_epoch": retry,
            "provider": "google",
            "model": MODEL_ID,
            "updated_at": now,
        })
        print(json.dumps({
            "status": "degraded",
            "reason": reason,
            "retry_after_s": COOLDOWN_S if reason == "quota_exhausted" else 0,
            "provider_attempts": attempts,
        }))
        return 75

    try:
        out = compact_success(run.stdout, revision, provider_attempts=attempts)
    except (ValueError, PolicyError) as exc:
        atomic_json(STATE, {
            "state": "blocked",
            "reason": str(exc),
            "provider": "google",
            "model": MODEL_ID,
            "updated_at": int(time.time()),
        })
        print(json.dumps({
            "status": "blocked",
            "reason": str(exc),
            "provider_attempts": attempts,
        }))
        return 78
    print(json.dumps(out, ensure_ascii=False))
    return 0


PUBLIC_MAX_BYTES = 65536
PUBLIC_INPUT_KEYS = {"version", "query", "responseLanguage", "sources", "remainingBudgetMs", "correlationId"}


def public_string(value, limit: int, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\0" in value:
        raise PolicyError("invalid_" + name)
    return value


def validate_public_input(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != PUBLIC_INPUT_KEYS or type(value["version"]) is not int or value["version"] != 1:
        raise PolicyError("invalid_public_input")
    public_string(value["query"], 1000, "query")
    if not isinstance(value["responseLanguage"], str) or value["responseLanguage"] not in {"fr", "en", "ar", "aeb", "aeb-Latn"}:
        raise PolicyError("invalid_response_language")
    if not isinstance(value["correlationId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", value["correlationId"]):
        raise PolicyError("invalid_correlation")
    budget = value["remainingBudgetMs"]
    if type(budget) is not int or not 1 <= budget <= 12000:
        raise PolicyError("invalid_budget")
    sources = value["sources"]
    if not isinstance(sources, list) or not 1 <= len(sources) <= 5:
        raise PolicyError("invalid_sources")
    ids = set()
    for source in sources:
        if not isinstance(source, dict) or set(source) != {"id", "title", "url", "excerpt"}:
            raise PolicyError("invalid_source")
        sid = public_string(source["id"], 24, "source_id")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", sid) or sid in ids:
            raise PolicyError("invalid_source_id")
        ids.add(sid)
        public_string(source["title"], 300, "source_title")
        public_string(source["excerpt"], 1500, "source_excerpt")
        url = urlsplit(public_string(source["url"], 2048, "source_url"))
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.fragment:
            raise PolicyError("invalid_source_url")
        hostname = url.hostname.rstrip(".").lower()
        if hostname in {"localhost", "localhost.localdomain", "metadata.google.internal"} or hostname.endswith((".localhost", ".local", ".internal")):
            raise PolicyError("invalid_source_url")
        try:
            if not ipaddress.ip_address(hostname).is_global:
                raise PolicyError("invalid_source_url")
        except ValueError:
            if re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9.]+)", hostname):
                raise PolicyError("invalid_source_url")
    if secret_like(json.dumps(value, ensure_ascii=False)):
        raise PolicyError("secret_like_payload_refused")
    return value


def public_degradation(code: str, stage="synthesis", attempts=0, elapsed=None) -> dict:
    return {"version": 1, "outcome": "partial", "model": None, "profile": None,
            "claims": [], "spokenText": "", "metrics": {"synthesisMs": elapsed,
                "providerAttempts": attempts, "reportedCostUsd": None},
            "error": {"code": code, "stage": stage}}


def validate_public_result(value: object, request: dict) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "outcome", "model", "profile", "claims", "spokenText", "metrics", "error"}:
        raise PolicyError("invalid_synthesis_result")
    if type(value["version"]) is not int or value["version"] != 1 or value["outcome"] != "complete" or value["model"] != MODEL or value["profile"] != PROFILE or value["error"] is not None:
        raise PolicyError("invalid_synthesis_result")
    claims = value["claims"]
    if not isinstance(claims, list) or not 1 <= len(claims) <= 12:
        raise PolicyError("invalid_claims")
    sources = {s["id"]: s for s in request["sources"]}
    ids = set()
    for claim in claims:
        if not isinstance(claim, dict) or set(claim) != {"id", "text", "sourceIds", "support"}:
            raise PolicyError("invalid_claim")
        cid = public_string(claim["id"], 24, "claim_id")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", cid) or cid in ids:
            raise PolicyError("invalid_claim_id")
        ids.add(cid)
        public_string(claim["text"], 1000, "claim_text")
        if re.search(r"(?:https?://|www\.)", claim["text"], re.I):
            raise PolicyError("url_in_claim_refused")
        referenced = claim["sourceIds"]
        if not isinstance(referenced, list) or not referenced or len(referenced) > 5 or any(not isinstance(s, str) or s not in sources for s in referenced) or len(set(referenced)) != len(referenced):
            raise PolicyError("invalid_citations")
        support = claim["support"]
        if not isinstance(support, list) or not 1 <= len(support) <= 5:
            raise PolicyError("invalid_support")
        supported = set()
        for item in support:
            if not isinstance(item, dict) or set(item) != {"sourceId", "quote"} or not isinstance(item["sourceId"], str) or item["sourceId"] not in referenced:
                raise PolicyError("invalid_support")
            quote = public_string(item["quote"], 1500, "quote")
            if quote not in sources[item["sourceId"]]["excerpt"]:
                raise PolicyError("unsupported_quote")
            supported.add(item["sourceId"])
        if supported != set(referenced):
            raise PolicyError("unsupported_citation")
        if not any(item["quote"] == claim["text"] for item in support):
            raise PolicyError("synthesis_review_required")
    # Deterministic oral rendering: no independent model-authored assertions.
    expected_spoken = " ".join(c["text"] for c in claims)
    if len(expected_spoken) > 1200 or value["spokenText"] != expected_spoken or secret_like(expected_spoken):
        raise PolicyError("invalid_spoken_text")
    metrics = value["metrics"]
    if not isinstance(metrics, dict) or set(metrics) != {"synthesisMs", "providerAttempts", "reportedCostUsd"} or type(metrics.get("providerAttempts")) is not int or metrics.get("providerAttempts") != 1 or metrics.get("reportedCostUsd") is not None:
        raise PolicyError("invalid_synthesis_metrics")
    return value


def strict_public_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise PolicyError("duplicate_json_key")
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(PolicyError("invalid_json_number")))


def run_public_provider(request: dict, deadline: float):
    helper = Path(__file__).resolve().with_name("gemini-public-synthesis.mjs")
    # Own the child process group, including npm metadata lookup. Cancellation
    # and timeout must not leave a detached provider generation running locally.
    proc = subprocess.Popen(["node", str(helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    previous = {}
    def cancelled(_signum, _frame):
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        raise InterruptedError("public_synthesis_cancelled")
    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, cancelled)
        stdout, _ = proc.communicate(json.dumps(request), timeout=max(0.001, deadline - time.monotonic()))
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, "")
    finally:
        for signum, handler in previous.items(): signal.signal(signum, handler)
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        proc.wait()


def public_synthesis_main() -> int:
    started = time.monotonic()
    attempts = 0
    try:
        raw = sys.stdin.buffer.read(PUBLIC_MAX_BYTES + 1)
        if len(raw) > PUBLIC_MAX_BYTES:
            raise PolicyError("public_input_too_large")
        request = validate_public_input(strict_public_json(raw))
        deadline = started + request["remainingBudgetMs"] / 1000
        ensure_free_policy()
        ensure_efficiency_policy()
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            raise PolicyError("deadline_exceeded")
        request = {**request, "remainingBudgetMs": remaining}
        attempts = None  # Child may begin generation before a transport timeout.
        result = run_public_provider(request, deadline)
        if time.monotonic() >= deadline:
            raise PolicyError("deadline_exceeded")
        if result.returncode or len(result.stdout.encode()) > PUBLIC_MAX_BYTES:
            raise PolicyError("public_provider_unavailable")
        value = strict_public_json(result.stdout)
        if isinstance(value, dict) and value.get("outcome") == "partial":
            # Project only bounded machine codes; never trust raw provider errors.
            error = value.get("error")
            metrics = value.get("metrics")
            code = error.get("code") if isinstance(error, dict) else None
            allowed = {"sdk_unavailable", "profile_unavailable", "policy_refused", "model_unavailable", "quota_exhausted", "provider_unavailable", "deadline_exceeded", "cancelled", "invalid_provider_response", "synthesis_review_required"}
            value = public_degradation(code if code in allowed else "public_provider_unavailable",
                attempts=metrics.get("providerAttempts") if isinstance(metrics, dict) and type(metrics.get("providerAttempts")) is int and metrics.get("providerAttempts") in (0, 1) else None)
        else:
            value = validate_public_result(value, request)
    except subprocess.TimeoutExpired:
        value = public_degradation("deadline_exceeded", attempts=attempts)
    except InterruptedError:
        value = public_degradation("cancelled", attempts=attempts)
    except PolicyError as exc:
        value = public_degradation("synthesis_review_required" if str(exc) == "synthesis_review_required" else "public_synthesis_refused", attempts=attempts)
    except (ValueError, OSError, TypeError, KeyError):
        value = public_degradation("public_synthesis_refused", attempts=attempts)
    value["metrics"]["synthesisMs"] = round((time.monotonic() - started) * 1000)
    print(json.dumps(value, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
