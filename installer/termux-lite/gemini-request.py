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


def capability_hint(message: str) -> dict:
    local = Path(__file__).resolve().with_name("claw-capability.py")
    script = local if local.exists() else runtime_script("claw-capability.py")
    if not script.exists():
        return {}
    try:
        run = subprocess.run(
            [sys.executable, str(script), "resolve", message, "--surface", "gemini_claw", "--caller", "owner"],
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


def load_status() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def fast_path_request(message: str) -> dict:
    script = Path(__file__).resolve().with_name("model-fast-path.py")
    if not script.exists():
        return {"status": "miss", "reason": "helper_missing"}
    try:
        run = subprocess.run(
            [sys.executable, str(script), message],
            capture_output=True,
            text=True,
            timeout=25,
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
    parser = argparse.ArgumentParser(description="Free-only Claw Gemini request entrypoint")
    parser.add_argument("--session", default="default")
    parser.add_argument("--timeout", type=int, default=60)
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

    fast = fast_path_request(message)
    if fast.get("status") == "hit":
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

    revision, memory = compact_memory(message)
    capability = capability_hint(message)
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


if __name__ == "__main__":
    raise SystemExit(main())
