"""Pure policy for the existing health manager; no probes, writes or restart.

Probes, idle proof and the receipt live in gateway-memory-guard.py, invoked by
samantha-health-manager.sh. These inputs are not a second source of truth.
"""
from dataclasses import dataclass
import math
import re

MIB = 1024  # KiB per MiB
# Existing native owner of Gateway memory alerts (OpenClaw dist/diagnostic-*.mjs,
# capture s24-2026-10-11b/p0-4-5b): warning 1536 MiB, critical 3072 MiB.
NATIVE_RSS_WARNING_KIB = 1536 * MIB
NATIVE_RSS_CRITICAL_KIB = 3072 * MIB
# Thresholds from real S24 measurements (captures s24-2026-10-10/p0-4-5 and
# s24-2026-10-11b/p0-4-5b): Gateway RSS 1.08-1.80 GiB in 15 native events and 4
# stability bundles (max 1856 MiB), VmHWM 2212 MiB; swap 592-840 MiB;
# MemAvailable >= 2.35 GiB. RSS 2560 MiB sits above every observed peak and below
# the native critical level; swap 1536 MiB is ~1.8x the observed max;
# MemAvailable reuses the companion-deploy.sh preflight floor (1200 MB); load
# reuses its 7 (recorded only, never a restart reason by itself); 10 min is the
# native rss_growth window.
RESTART_COOLDOWN_SECONDS = 6 * 3600


@dataclass(frozen=True)
class Metrics:
    rss_kib: int | None
    swap_kib: int | None
    available_kib: int | None
    load_one: float | None


@dataclass(frozen=True)
class Thresholds:
    rss_kib: int
    swap_kib: int
    available_kib: int
    load_one: float
    sustained_seconds: int


MEASURED_THRESHOLDS = Thresholds(rss_kib=2560 * MIB, swap_kib=1536 * MIB,
                                 available_kib=1200 * MIB, load_one=7.0,
                                 sustained_seconds=600)


@dataclass(frozen=True)
class IdleProof:
    observed_at: float
    complete: bool
    active_runs: bool | None
    active_payment: bool | None
    active_confirmation: bool | None




def _finite(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def metrics_from_owner_observation(proc_status, meminfo, uptime):
    """Decode bounded probes from the health-manager UID; no I/O or restart.

    Android denies /proc/loadavg and PSI on the captured S24. The existing
    uptime/sysinfo path supplies load; a failed or malformed probe stays unknown.
    No default thresholds, credentials, payment state or idle proof are inferred.
    """
    def kib(mapping, key):
        value = mapping.get(key) if isinstance(mapping, dict) else None
        if not isinstance(value, str) or len(value) > 80:
            return None
        match = re.fullmatch(r'([0-9]{1,15})[ \t]+kB', value)
        return int(match.group(1)) if match else None
    load = None
    if isinstance(uptime, str) and len(uptime) <= 4096:
        match = re.search(r'load averages?: ([0-9]+(?:\.[0-9]+)?),? '
                          r'([0-9]+(?:\.[0-9]+)?),? ([0-9]+(?:\.[0-9]+)?)\s*$', uptime)
        if match:
            candidate = float(match.group(1))
            load = candidate if _finite(candidate) else None
    return Metrics(kib(proc_status, 'VmRSS'), kib(proc_status, 'VmSwap'),
                   kib(meminfo, 'MemAvailable'), load)


def pressure(metrics: Metrics, thresholds: Thresholds):
    """Unknown measurements cannot authorize a restart or masquerade as zero."""
    values = (metrics.rss_kib, metrics.swap_kib, metrics.available_kib, metrics.load_one)
    limits = (thresholds.rss_kib, thresholds.swap_kib, thresholds.available_kib,
              thresholds.load_one, thresholds.sustained_seconds)
    if not all(_finite(value) for value in values):
        return {"state": "unknown", "reasons": []}
    if not all(_finite(value) and value > 0 for value in limits):
        return {"state": "unknown", "reasons": []}
    reasons = []
    if metrics.rss_kib > thresholds.rss_kib:
        reasons.append("gateway_rss")
    if metrics.swap_kib > thresholds.swap_kib:
        reasons.append("gateway_swap")
    if metrics.available_kib < thresholds.available_kib:
        reasons.append("memory_available")
    if metrics.load_one > thresholds.load_one:
        reasons.append("load")
    return {"state": "pressure" if reasons else "healthy", "reasons": reasons}


def restart_reasons(metrics: Metrics, thresholds: Thresholds):
    """Gateway-specific pressure only. Load alone never restarts the Gateway, and
    low MemAvailable counts only while the Gateway is above the native warning."""
    observed = pressure(metrics, thresholds)
    if observed["state"] != "pressure":
        return []
    reasons = [r for r in observed["reasons"] if r in ("gateway_rss", "gateway_swap")]
    if "memory_available" in observed["reasons"] and metrics.rss_kib > NATIVE_RSS_WARNING_KIB:
        reasons.append("memory_available")
    return reasons


def restart_decision(metrics, thresholds, *, now, sustained_since,
                     last_attempt_at, idle, qualified=False):
    """A caller must reserve a canonical receipt before calling restart.

    last_attempt_at includes failed/uncertain attempts. Unknown prior history
    blocks; missing history must be explicitly represented by zero only after
    its canonical owner has been read successfully. No retry is performed here.
    """
    def refused(reason):
        return {"allowed": False, "reason": reason}
    if qualified is not True:
        return refused("qualification_required")
    if not _finite(now) or not restart_reasons(metrics, thresholds):
        return refused("pressure_unproven")
    if not _finite(sustained_since) or sustained_since > now or now - sustained_since < thresholds.sustained_seconds:
        return refused("pressure_not_sustained")
    if not _finite(last_attempt_at) or last_attempt_at > now:
        return refused("restart_history_unknown")
    if last_attempt_at > 0 and now - last_attempt_at < RESTART_COOLDOWN_SECONDS:
        return refused("restart_cooldown")
    if not isinstance(idle, IdleProof) or idle.complete is not True or not _finite(idle.observed_at) or not 0 <= now - idle.observed_at <= 5:
        return refused("idle_unproven")
    if any(value is not False for value in (idle.active_runs, idle.active_payment, idle.active_confirmation)):
        return refused("runtime_busy_or_unknown")
    return {"allowed": True, "reason": "sustained_pressure_idle"}
