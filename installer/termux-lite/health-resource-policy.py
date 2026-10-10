"""Pure policy for the existing health manager; no probes, writes or restart.

The runtime wiring deliberately awaits the S24 config and complete idle proof.
These inputs are not a second source of truth or a new runtime file format.
"""
from dataclasses import dataclass
import math


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


@dataclass(frozen=True)
class IdleProof:
    observed_at: float
    complete: bool
    active_runs: bool | None
    active_payment: bool | None
    active_confirmation: bool | None


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


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
    if not _finite(now) or pressure(metrics, thresholds)["state"] != "pressure":
        return refused("pressure_unproven")
    if not _finite(sustained_since) or sustained_since > now or now - sustained_since < thresholds.sustained_seconds:
        return refused("pressure_not_sustained")
    if not _finite(last_attempt_at) or last_attempt_at > now:
        return refused("restart_history_unknown")
    if last_attempt_at > 0 and now - last_attempt_at < 6 * 3600:
        return refused("restart_cooldown")
    if not isinstance(idle, IdleProof) or idle.complete is not True or not _finite(idle.observed_at) or not 0 <= now - idle.observed_at <= 5:
        return refused("idle_unproven")
    if any(value is not False for value in (idle.active_runs, idle.active_payment, idle.active_confirmation)):
        return refused("runtime_busy_or_unknown")
    return {"allowed": True, "reason": "sustained_pressure_idle"}
