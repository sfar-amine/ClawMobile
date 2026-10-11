#!/data/data/com.termux/files/usr/bin/python3
"""P0-4 : garde mémoire de la Gateway, appelée par samantha-health-manager.sh (propriétaire
existant, cycle de 15 s, ici au plus une fois par minute). Une passe : mesures, pression
durable, preuve de repos, décision, reçu. Elle ne redémarre rien elle-même : quand la
décision est accordée, elle réserve le reçu puis imprime `restart_requested` ; le
health-manager appelle alors POST /v1/runtime/restart (redémarrage gracieux existant du
Companion), comme pour la récupération WhatsApp. Aucun démon, timer ni store nouveau :
le reçu `~/.openclaw/health/gateway-memory-guard.json` est un seul fichier réécrit.
"""
import argparse, fcntl, importlib.util, json, os, re, sqlite3, subprocess, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("health_resource_policy", HERE / "health-resource-policy.py")
policy = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = policy
_spec.loader.exec_module(policy)

OC = Path(os.environ.get("OPENCLAW_HOME", str(Path.home() / ".openclaw")))
RECEIPT = OC / "health" / "gateway-memory-guard.json"
REQUESTED_RESOLVE_S = 600
TASK_TERMINAL = {"cancelled", "failed", "succeeded", "timed_out"}
CRON_TERMINAL = {"ok", "error", "skipped"}
RUN_TERMINAL = {"done", "failed", "unknown", "cancelled", "expired"}
# Payment requests / owner confirmations: terminal or waiting on a human only.
# effect_unknown and blocked need a human check, not a running Gateway turn.
APPROVAL_TERMINAL = {"cancelled", "failed", "expired", "confirmed", "demo_confirmed", "completed",
                     "succeeded", "refused", "consumed", "effect_unknown", "blocked"}
APPROVAL_GRACE_MS = 10 * 60 * 1000
BRIDGE_ACTIVE = {"received", "running"}


def read_receipt(path=None):
    path = Path(path or RECEIPT)
    try:
        row = json.loads(path.read_text())
    except FileNotFoundError:
        return {"version": 1, "last_attempt": {"at": 0, "state": "none"}}, True
    except (OSError, ValueError):
        return None, False
    return (row, True) if isinstance(row, dict) and row.get("version") == 1 else (None, False)


def write_receipt(row, path=None):
    path = Path(path or RECEIPT)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(row, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)


def gateway_pid():
    try:
        out = subprocess.run(["pgrep", "-f", "openclaw-gateway"], text=True, capture_output=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    pids = [int(x) for x in out.split() if x.isdigit() and int(x) != os.getpid()]
    return min(pids) if len(pids) >= 1 else None


def status_fields(text):
    fields = {}
    for line in (text or "").splitlines()[:200]:
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip()
    return fields


def probe_metrics(pid):
    try:
        proc_status = status_fields(Path(f"/proc/{pid}/status").read_text()) if pid else None
    except OSError:
        proc_status = None
    try:
        meminfo = status_fields(Path("/proc/meminfo").read_text())
    except OSError:
        meminfo = None
    try:
        uptime = subprocess.run(["uptime"], text=True, capture_output=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        uptime = None
    return policy.metrics_from_owner_observation(proc_status, meminfo, uptime)


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def idle_proof(now, oc=None, deadline_s=3.0):
    """Exhaustive over the existing owners; any unreadable source -> None (busy/unknown)."""
    oc = Path(oc or OC)
    deadline = time.monotonic() + deadline_s
    busy = {}
    # Gateway tasks and cron runs (state/openclaw.sqlite, read-only).
    try:
        con = sqlite3.connect(f"file:{oc / 'state/openclaw.sqlite'}?mode=ro", uri=True, timeout=2)
        try:
            tasks = sum(n for status, n in con.execute("select status,count(*) from task_runs group by status") if status not in TASK_TERMINAL)
            crons = sum(n for status, n in con.execute("select status,count(*) from cron_run_receipts group by status") if status not in CRON_TERMINAL)
        finally:
            con.close()
        busy["gateway_tasks"] = tasks
        busy["cron_runs"] = crons
    except (sqlite3.Error, OSError):
        return None, "gateway_state_unreadable"
    # Companion runs, payment requests and owner confirmations: state/expiry only.
    try:
        registry = json.loads((oc / "clawmobile-companion/runs.json").read_text())
        runs = registry.get("runs") or []
        busy["companion_runs"] = sum(1 for r in runs if str(r.get("state")) not in RUN_TERMINAL)

        def active(rows):
            count = 0
            for row in rows or []:
                if str(row.get("state")) in APPROVAL_TERMINAL:
                    continue
                expires = row.get("expiresAt")
                if not isinstance(expires, (int, float)) or expires > now * 1000 - APPROVAL_GRACE_MS:
                    count += 1
            return count
        busy["payments"] = active(registry.get("paymentRequests"))
        busy["confirmations"] = active(registry.get("ownerConfirmations"))
    except (OSError, ValueError, AttributeError, TypeError):
        return None, "companion_registry_unreadable"
    # Remote Bridge requests still owned by a live instance (claw_exec, capabilities).
    try:
        live = 0
        for entry in os.scandir(oc / "remote-bridge/requests"):
            if time.monotonic() > deadline:
                return None, "remote_bridge_scan_partial"
            if not entry.name.endswith(".json") or not entry.is_file(follow_symlinks=False):
                continue
            try:
                row = json.loads(Path(entry.path).read_text())
            except (OSError, ValueError):
                continue
            if row.get("state") not in BRIDGE_ACTIVE:
                continue
            match = re.match(r"^(\d{1,10})-", str(row.get("instanceId") or ""))
            if not match or _pid_alive(int(match.group(1))):
                live += 1
        busy["remote_bridge"] = live
    except FileNotFoundError:
        busy["remote_bridge"] = 0
    except OSError:
        return None, "remote_bridge_unreadable"
    # Deploy in progress (existing companion-deploy.sh lock) or heavy job.
    try:
        lock = oc / "deploys/companion-deploy.lock"
        if lock.exists():
            fd = os.open(lock, os.O_RDONLY)
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                fcntl.flock(fd, fcntl.LOCK_UN)
                busy["deploy"] = 0
            except BlockingIOError:
                busy["deploy"] = 1
            finally:
                os.close(fd)
        else:
            busy["deploy"] = 0
        heavy = subprocess.run(["pgrep", "-fc", "GradleDaemon|gradle-termux|tsc -p tsconfig"], text=True, capture_output=True, timeout=3).stdout.strip()
        busy["heavy_job"] = int(heavy or 0)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None, "deploy_state_unreadable"
    return busy, None


def gateway_healthy():
    try:
        with urllib.request.urlopen("http://127.0.0.1:18789/healthz", timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def evaluate(now, prev, metrics, pid, idle_fn, healthy_fn, thresholds=None):
    thresholds = thresholds or policy.MEASURED_THRESHOLDS
    last = dict(prev.get("last_attempt") or {})
    # Resolve a previous request without replaying it.
    if last.get("state") == "requested":
        if pid and last.get("gateway_pid") and pid != last.get("gateway_pid") and healthy_fn():
            last.update(state="completed", resolved_at=now)
        elif now - float(last.get("at") or 0) > REQUESTED_RESOLVE_S:
            last.update(state="uncertain", resolved_at=now)
    reasons = policy.restart_reasons(metrics, thresholds)
    since = prev.get("pressure", {}).get("since") if reasons else None
    if reasons and not isinstance(since, (int, float)):
        since = now
    row = {
        "version": 1, "checked_at": now, "gateway_pid": pid,
        "metrics": {"rss_kib": metrics.rss_kib, "swap_kib": metrics.swap_kib,
                    "available_kib": metrics.available_kib, "load_one": metrics.load_one},
        "thresholds": {"rss_kib": thresholds.rss_kib, "swap_kib": thresholds.swap_kib,
                       "available_kib": thresholds.available_kib, "load_one": thresholds.load_one,
                       "sustained_seconds": thresholds.sustained_seconds,
                       "cooldown_seconds": policy.RESTART_COOLDOWN_SECONDS},
        "pressure": {"state": policy.pressure(metrics, thresholds)["state"], "reasons": reasons, "since": since},
        "last_attempt": last,
    }
    last_at = last.get("at")
    if last.get("state") == "unknown":
        last_at = None
    idle = None
    busy = None
    # The idle proof is read only when everything else already allows a restart.
    pre = policy.restart_decision(metrics, thresholds, now=now, sustained_since=since, last_attempt_at=last_at,
                                  idle=policy.IdleProof(now, True, False, False, False), qualified=True)
    if pre["allowed"]:
        busy, why = idle_fn(now)
        if busy is None:
            idle = policy.IdleProof(now, False, None, None, None)
            row["idle"] = {"complete": False, "reason": why}
        else:
            runs = (busy["gateway_tasks"] + busy["cron_runs"] + busy["companion_runs"] + busy["remote_bridge"]
                    + busy["deploy"] + busy["heavy_job"])
            idle = policy.IdleProof(now, True, runs > 0, busy["payments"] > 0, busy["confirmations"] > 0)
            row["idle"] = {"complete": True, **busy}
    decision = policy.restart_decision(metrics, thresholds, now=now, sustained_since=since, last_attempt_at=last_at,
                                       idle=idle, qualified=True) if pre["allowed"] else pre
    row["decision"] = decision
    if decision["allowed"]:
        # Reserved before the request: a failed or uncertain attempt still counts for 6 h.
        row["last_attempt"] = {"at": now, "state": "requested", "gateway_pid": pid, "reasons": reasons}
        row["action"] = "restart_requested"
    else:
        row["action"] = "none"
    return row


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observe", action="store_true", help="décision calculée, aucune demande de redémarrage")
    args = parser.parse_args(argv)
    now = time.time()
    prev, ok = read_receipt()
    if not ok:
        # Unreadable history: never restart; keep the corrupt receipt for a human.
        print(json.dumps({"action": "none", "reason": "restart_history_unknown"}))
        return 0
    pid = gateway_pid()
    row = evaluate(now, prev, probe_metrics(pid), pid, idle_proof, gateway_healthy)
    # First activation is observation only: a restart request needs the explicit
    # SAMANTHA_GATEWAY_MEMORY_RESTART=1 (no S24 env file owns this switch yet).
    row["mode"] = "restart" if not args.observe and os.environ.get("SAMANTHA_GATEWAY_MEMORY_RESTART") == "1" else "observe"
    if row["mode"] == "observe":
        if row["action"] == "restart_requested":
            row["action"] = "observe_only"
            row["last_attempt"] = prev.get("last_attempt") or {"at": 0, "state": "none"}
    write_receipt(row)
    print(json.dumps({"action": row["action"], "mode": row["mode"], "reason": row["decision"]["reason"],
                      "pressure": row["pressure"]["reasons"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
