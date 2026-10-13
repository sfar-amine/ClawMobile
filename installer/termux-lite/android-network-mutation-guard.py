#!/data/data/com.termux/files/usr/bin/python3
from __future__ import annotations
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

HOME = Path.home()
ROOT = HOME / ".openclaw" / "network-mutation"
LEASES = ROOT / "leases"
RECEIPT = HOME / ".openclaw" / "health" / "network-mutation-safety.json"
ADB_ENDPOINT = os.environ.get("SAMANTHA_ADB_ENDPOINT", "127.0.0.1:5556")
ADB = ["adb", "-s", ADB_ENDPOINT]
KEYS = (
    "http_proxy",
    "global_http_proxy_host",
    "global_http_proxy_port",
    "global_http_proxy_exclusion_list",
    "global_proxy_pac_url",
)
# Samsung "Auto Wi-Fi" re-enables Wi-Fi near known networks during a Wi-Fi-off operation
# (payment incident 11/10: Maxit fell back to Wi-Fi mid-flow). Both keys live in
# `settings global` on the S24 (read-only probe 10/10: auto_wifi=1, sem_auto_wifi_control_enabled=1).
AUTO_WIFI_KEYS = ("auto_wifi", "sem_auto_wifi_control_enabled")
WIFI_WATCH_INTERVAL_S = 0.5
CHILD_STOP_GRACE_S = 2.0
WIFI_REENABLED_EXIT = 3
MAX_LEASE_AGE = int(os.environ.get("NETWORK_MUTATION_MAX_LEASE_AGE", "900"))
TERMUX_PACKAGES = ("com.termux", "com.termux.api", "com.termux.boot")
CELLULAR_FORWARD_REMOTE = "localabstract:ai.samantha.cellular"
CELLULAR_SOCKET_RE = re.compile(r"samantha-cellular-[a-f0-9]{32}\.sock")
HEALTH_LOG = HOME / ".openclaw" / "health" / "health.log"
BOUNDED_LOG = Path(__file__).resolve().with_name("bounded-log.py")
# Incident S24 11/10 16:00 : Wi-Fi coupé 40 min, aucun garde vivant, aucun bail. La restauration
# du Wi-Fi ne doit jamais dépendre de la survie du garde : bail borné (TTL) + restaurateur détaché.
# Budget par appel fournisseur ≤ 60 s (paiement / start) ; TTL = max(budget, 120 s), plafonné.
PURPOSE_BUDGET_S = {"maxit-deterministic": 60, "maxit-topup-payment": 60}
DEFAULT_PURPOSE_BUDGET_S = 60
WIFI_OFF_MIN_TTL_S = 120
WIFI_OFF_MAX_TTL_S = 600
# Le garde arrête lui-même l'enfant avant l'échéance pour restaurer avant le restaurateur.
RESTORE_MARGIN_S = 20
RESTORER_POLL_S = 1.0
RESTORER_ATTEMPTS = 6
RESTORER_RETRY_S = 10.0
RESTORE_LOCK_TIMEOUT_S = 30.0
WIFI_TTL_EXIT = 4
WIFI_GUARD_BUSY_EXIT = 5
WIFI_RESTORER_UNAVAILABLE_EXIT = 6
WIFI_UNMANAGED_WARNING = "wifi_disabled_without_lease"

def wifi_off_ttl(purpose: str) -> int:
    budget = int(PURPOSE_BUDGET_S.get(purpose, DEFAULT_PURPOSE_BUDGET_S))
    return min(WIFI_OFF_MAX_TTL_S, max(budget, WIFI_OFF_MIN_TTL_S))

def log_line(text: str) -> None:
    """Une ligne dans le journal santé existant (bounded-log), jamais bloquante."""
    try:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        subprocess.run([sys.executable, str(BOUNDED_LOG), str(HEALTH_LOG), "--append",
                        f"{stamp} component=network-mutation-guard {text}"],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass

def adb(*args: str, timeout: int = 6, check: bool = False, serial: str | None = None) -> subprocess.CompletedProcess:
    command = [ADB[0], "-s", serial] if serial is not None else ADB
    p = subprocess.run(command + list(args), text=True, capture_output=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError("adb_command_failed")
    return p

def settings_state(keys: tuple[str, ...] = KEYS) -> dict:
    raw = adb("shell", "settings", "list", "global", check=True).stdout
    rows = {}
    for line in raw.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            rows[key] = value
    return {key: {"exists": key in rows, "value": rows.get(key)} for key in keys}

def auto_wifi_state() -> dict:
    return settings_state(AUTO_WIFI_KEYS)

def disable_auto_wifi(snapshot: dict) -> None:
    """Force both Auto Wi-Fi keys to 0 for the operation; the lease already holds the exact pre-state."""
    for key in AUTO_WIFI_KEYS:
        if snapshot[key] != {"exists": True, "value": "0"}:
            adb("shell", "settings", "put", "global", key, "0", check=True)
    if any(row != {"exists": True, "value": "0"} for row in auto_wifi_state().values()):
        raise RuntimeError("auto_wifi_disable_mismatch")

def restore_auto_wifi(snapshot: dict) -> None:
    """Exact restore: an originally absent key is deleted, never written as null."""
    current = auto_wifi_state()
    for key in AUTO_WIFI_KEYS:
        wanted = snapshot[key]
        if current[key] == wanted:
            continue
        if wanted["exists"]:
            if wanted["value"] in (None, ""):
                raise RuntimeError("empty_auto_wifi_restore_unsupported")
            adb("shell", "settings", "put", "global", key, wanted["value"], check=True)
        else:
            adb("shell", "settings", "delete", "global", key, check=True)
    if auto_wifi_state() != snapshot:
        raise RuntimeError("auto_wifi_restore_mismatch")

def wifi_enabled() -> bool:
    raw = adb("shell", "cmd", "wifi", "status", check=True).stdout.strip().lower()
    if "wi-fi is enabled" in raw or "wifi is enabled" in raw:
        return True
    if "wi-fi is disabled" in raw or "wifi is disabled" in raw:
        return False
    raise RuntimeError("wifi_state_unknown")

def parse_default_network(raw: str) -> dict:
    """`dumpsys connectivity` -> {"transport": wifi|cellular|none|other|unknown, "validated": bool}.

    Format confirmé sur le S24 (capture 11/10, fixture s24-2026-10-11/android) :
    `Active default network: 127` puis `NetworkAgentInfo{network{127} ... Transports: CELLULAR Capabilities: ...&VALIDATED&...`."""
    m = re.search(r"^Active default network: (\S+)", raw, re.M)
    if not m:
        return {"transport": "unknown", "validated": False}
    if m.group(1).lower() in ("none", "null"):
        return {"transport": "none", "validated": False}
    agent = None
    for line in raw.splitlines():
        if f"NetworkAgentInfo{{network{{{m.group(1)}}}" in line:
            agent = line
            break
    if agent is None:
        return {"transport": "unknown", "validated": False}
    t = re.search(r"Transports: ([A-Z_|]+)", agent)
    caps = re.search(r"Capabilities: ([A-Z_&]+)", agent)
    transports = set(t.group(1).split("|")) if t else set()
    validated = "VALIDATED" in (caps.group(1).split("&") if caps else [])
    if transports == {"WIFI"}:
        kind = "wifi"
    elif transports == {"CELLULAR"}:
        kind = "cellular"
    else:
        kind = "other" if transports else "unknown"
    return {"transport": kind, "validated": validated}

def default_network() -> dict:
    return parse_default_network(adb("shell", "dumpsys", "connectivity", timeout=8, check=True).stdout)

def wifi_connected() -> bool:
    return "wifi is connected to" in adb("shell", "cmd", "wifi", "status", check=True).stdout.lower()

def wifi_toggle_decision() -> dict:
    """Ne couper le Wi-Fi que s'il est réellement le réseau par défaut connecté (demande d'Amine 11/10 :
    en 4G, Wi-Fi activé mais connecté à rien, aucune dépendance au Wi-Fi)."""
    if not wifi_enabled():
        return {"toggle": False, "detail": "wifi_disabled", "wifi_enabled": False}
    try:
        net = default_network()
    except (RuntimeError, OSError, subprocess.SubprocessError):
        net = {"transport": "unknown", "validated": False}
    if net["transport"] == "wifi":
        return {"toggle": True, "detail": "wifi_default", "wifi_enabled": True}
    if net["transport"] == "cellular":
        return {"toggle": False, "detail": "cellular_default" + ("_validated" if net["validated"] else ""),
                "wifi_enabled": True}
    if net["transport"] == "none":
        return {"toggle": False, "detail": "wifi_not_connected", "wifi_enabled": True}
    # Lecture inconnue (ou VPN) : seul un Wi-Fi explicitement connecté justifie la coupure.
    if wifi_connected():
        return {"toggle": True, "detail": "wifi_connected_default_unknown", "wifi_enabled": True}
    return {"toggle": False, "detail": "wifi_not_connected", "wifi_enabled": True}

def set_wifi(enabled: bool, timeout_s: float = 8.0) -> None:
    adb("shell", "svc", "wifi", "enable" if enabled else "disable", check=True)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if wifi_enabled() is enabled:
                return
        except RuntimeError:
            pass
        time.sleep(.25)
    raise RuntimeError("wifi_state_change_timeout")

def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".lease-", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def restore_state(state: dict) -> None:
    current = settings_state()
    for key in KEYS:
        wanted = state[key]
        if current[key] == wanted:
            continue
        if wanted["exists"]:
            value = wanted["value"] or ""
            if value == "":
                raise RuntimeError("empty_network_setting_restore_unsupported")
            adb("shell", "settings", "put", "global", key, value, check=True)
        else:
            adb("shell", "settings", "delete", "global", key, check=True)
    if settings_state() != state:
        raise RuntimeError("network_settings_restore_mismatch")

def restore_lease(row: dict) -> None:
    restore_state(row["settings"])
    if row.get("type") == "wifi_off":
        expected = bool(row.get("wifi_enabled"))
        wifi_error = None
        try:
            if wifi_enabled() is not expected:
                set_wifi(expected)
            if wifi_enabled() is not expected:
                raise RuntimeError("wifi_restore_mismatch")
        except Exception as exc:  # still restore Auto Wi-Fi, then report the first failure
            wifi_error = exc
        # Leases written before Auto Wi-Fi snapshotting carry no key: nothing of ours to restore.
        if isinstance(row.get("auto_wifi"), dict):
            restore_auto_wifi(row["auto_wifi"])
        if wifi_error is not None:
            raise wifi_error

def proxy_active(state: dict) -> bool:
    hp = (state["http_proxy"]["value"] or "").strip().lower()
    host = (state["global_http_proxy_host"]["value"] or "").strip().lower()
    port = (state["global_http_proxy_port"]["value"] or "").strip().lower()
    pac = (state["global_proxy_pac_url"]["value"] or "").strip().lower()
    return hp not in ("", "null", ":0") or host not in ("", "null") or port not in ("", "null", "0") or pac not in ("", "null")

def _allow_mode(text: str, op: str) -> bool:
    return f"{op}: allow" in text or "Default mode: allow" in text

def installed_termux_packages() -> dict[str, int]:
    raw = adb("shell", "pm", "list", "packages", "-U", "com.termux", check=True).stdout
    rows = {}
    for line in raw.splitlines():
        m = re.fullmatch(r"package:(\S+)\s+uid:(\d+)", line.strip())
        if m and m.group(1) in TERMUX_PACKAGES:
            rows[m.group(1)] = int(m.group(2))
    if "com.termux" not in rows:
        raise RuntimeError("termux_package_missing")
    return rows

def termux_background_state() -> dict:
    packages = installed_termux_packages()
    idle_raw = adb("shell", "dumpsys", "deviceidle", "whitelist", check=True).stdout
    net_raw = adb("shell", "cmd", "netpolicy", "list", "restrict-background-whitelist", check=True).stdout
    whitelisted_uids = {int(x) for x in re.findall(r"\b\d+\b", net_raw.split(":", 1)[-1])}
    details = {}
    for pkg, uid in packages.items():
        any_bg = adb("shell", "cmd", "appops", "get", pkg, "RUN_ANY_IN_BACKGROUND")
        run_bg = adb("shell", "cmd", "appops", "get", pkg, "RUN_IN_BACKGROUND")
        inactive = adb("shell", "am", "get-inactive", pkg, check=True).stdout.strip().lower()
        bucket_raw = adb("shell", "am", "get-standby-bucket", pkg, check=True).stdout.strip()
        try: bucket = int(bucket_raw)
        except ValueError: bucket = 999
        h = adb("shell", "cmd", "app_hibernation", "get-state", pkg)
        h_text = h.stdout.strip().lower()
        h_supported = h.returncode == 0 and h_text in {"true", "false"}
        row = {
            "uid": uid,
            "doze_whitelisted": f"user,{pkg},{uid}" in idle_raw.splitlines(),
            "run_any_in_background": any_bg.returncode == 0 and _allow_mode(any_bg.stdout, "RUN_ANY_IN_BACKGROUND"),
            "run_in_background": run_bg.returncode == 0 and _allow_mode(run_bg.stdout, "RUN_IN_BACKGROUND"),
            "inactive": "idle=true" in inactive,
            "standby_bucket": bucket,
            "hibernation_supported": h_supported,
            "hibernated": h_text == "true" if h_supported else False,
        }
        row["healthy"] = (row["doze_whitelisted"] and row["run_any_in_background"] and
                          row["run_in_background"] and not row["inactive"] and
                          row["standby_bucket"] <= 10 and
                          (not h_supported or not row["hibernated"]))
        details[pkg] = row
    uids = sorted(set(packages.values()))
    data_saver = {str(uid): uid in whitelisted_uids for uid in uids}
    healthy = all(r["healthy"] for r in details.values()) and all(data_saver.values())
    return {"healthy": healthy, "packages": details, "data_saver_whitelisted": data_saver}

def repair_termux_background(state: dict) -> None:
    repaired_uids = set()
    for pkg, row in state["packages"].items():
        uid = int(row["uid"])
        if not row["doze_whitelisted"]:
            adb("shell", "dumpsys", "deviceidle", "whitelist", "+" + pkg, check=True)
        if not row["run_any_in_background"]:
            adb("shell", "cmd", "appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", "allow", check=True)
        if not row["run_in_background"]:
            adb("shell", "cmd", "appops", "set", pkg, "RUN_IN_BACKGROUND", "allow", check=True)
        if row["inactive"] or int(row["standby_bucket"]) > 10:
            adb("shell", "am", "set-inactive", pkg, "false", check=True)
            adb("shell", "am", "set-standby-bucket", pkg, "active", check=True)
        if row["hibernation_supported"] and row["hibernated"]:
            adb("shell", "cmd", "app_hibernation", "set-state", pkg, "false", check=True)
        if not state["data_saver_whitelisted"].get(str(uid), False) and uid not in repaired_uids:
            adb("shell", "cmd", "netpolicy", "add", "restrict-background-whitelist", str(uid), check=True)
            repaired_uids.add(uid)

def ensure_termux_background_network() -> dict:
    before = termux_background_state()
    if before["healthy"]:
        return {"state": "healthy", "mutation": "none", "details": before}
    repair_termux_background(before)
    after = termux_background_state()
    if not after["healthy"]:
        raise RuntimeError("termux_background_policy_repair_mismatch")
    return {"state": "healthy", "mutation": "repaired", "details": after}

def lease_alive(row: dict) -> bool:
    pid = int(row.get("owner_pid") or 0)
    if pid <= 0:
        return False
    if row.get("type") == "adb_forward":
        return forward_owner_state(row) == "ALIVE"
    if row.get("owner_identity"):
        # PID réutilisé ou zombie (tué, pas encore récolté) = propriétaire mort ;
        # identité illisible = pas une preuve de mort (le TTL borne l'attente).
        try:
            if (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
                return False
        except (OSError, IndexError):
            pass
        return forward_owner_state(row) in ("ALIVE", "UNKNOWN")
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def lease_expired(row: dict, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    if row.get("expires_at") is not None:
        return now >= float(row["expires_at"])
    return max(0, now - float(row.get("created_at", 0))) > MAX_LEASE_AGE

def create_lease(purpose: str, *, lease_type: str = "global_proxy", include_wifi: bool = False,
                 ttl_s: int | None = None, decision: dict | None = None) -> Path:
    if lease_type not in {"global_proxy", "wifi_off"}:
        raise ValueError("unsupported_network_lease_type")
    if include_wifi != (lease_type == "wifi_off"):
        raise ValueError("wifi_lease_contract_mismatch")
    LEASES.mkdir(parents=True, exist_ok=True)
    lease_id = uuid.uuid4().hex
    lease = LEASES / (lease_id + ".json")
    now = time.time()
    row = {
        "schema_version": 1,
        "type": lease_type,
        "created_at": now,
        "owner_pid": os.getpid(),
        "purpose": purpose,
        "settings": settings_state(),
    }
    if include_wifi:
        # Format existant étendu (schema 2) : TTL, échéance, jeton propriétaire, identité du garde.
        row["wifi_enabled"] = wifi_enabled()
        row["auto_wifi"] = auto_wifi_state()
        row.update(schema_version=2, lease_id=lease_id, owner_token=uuid.uuid4().hex,
                   owner_identity=process_identity(os.getpid()))
        if ttl_s is not None:
            row.update(ttl_s=int(ttl_s), expires_at=now + int(ttl_s))
        if decision is not None:
            row["network_decision"] = decision.get("detail")
    write_json(lease, row)
    return lease

def process_identity(pid: int) -> dict | None:
    """PID alone is not an ownership receipt: include birth and boot identity."""
    try:
        proc = Path("/proc") / str(pid)
        fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z" or proc.stat().st_uid != os.getuid():
            return None
        return {"start_ticks": fields[19], "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    except (OSError, IndexError, ValueError):
        return None

def forward_owner_state(row: dict) -> str:
    """An unreadable identity is UNKNOWN, never proof that its owner died."""
    pid = row.get("owner_pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or not row.get("owner_identity"):
        return "UNKNOWN"
    observed = process_identity(pid)
    if observed is not None:
        return "ALIVE" if observed == row["owner_identity"] else "REPLACED"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "DEAD"
    except OSError:
        return "UNKNOWN"
    return "UNKNOWN"

@contextmanager
def mutation_lock(timeout_s: float = 5.0):
    """Serialize mutations and reconciliation in this existing authority."""
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(ROOT / "guard.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + timeout_s
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("network_mutation_guard_busy")
                time.sleep(0.025)
        yield
    finally:
        os.close(fd)

def forward_lease_path(lease_id: str) -> Path:
    if not isinstance(lease_id, str) or not re.fullmatch(r"[a-f0-9]{32}", lease_id):
        raise ValueError("invalid_forward_lease_id")
    path = LEASES / (lease_id + ".json")
    if path.is_symlink() or LEASES.is_symlink():
        raise ValueError("invalid_forward_lease_path")
    return path

def forward_server_identity() -> dict:
    # A changed ADB host/socket configuration must never redirect cleanup.
    binary = shutil.which(ADB[0])
    return {"binary": str(Path(binary).resolve()) if binary else None, **{key: os.environ.get(key) for key in (
        "ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_ADDRESS", "ANDROID_ADB_SERVER_PORT")}}

def _cellular_socket_path(local: str) -> Path | None:
    if not isinstance(local, str) or not local.startswith("localfilesystem:"):
        return None
    raw = local.split(":", 1)[1]
    prefix = os.environ.get("PREFIX")
    if not prefix:
        raise ValueError("missing_termux_prefix")
    prefix_path = Path(prefix)
    path = Path(raw)
    parent = prefix_path / "tmp"
    if (not prefix_path.is_absolute() or not path.is_absolute() or path.parent != parent
            or not CELLULAR_SOCKET_RE.fullmatch(path.name)):
        raise ValueError("invalid_forward_local")
    try:
        parent_lstat = parent.lstat()
        resolved_parent = parent.resolve(strict=True)
    except OSError as exc:
        raise ValueError("insecure_forward_parent") from exc
    if (not stat.S_ISDIR(parent_lstat.st_mode) or resolved_parent != parent
            or parent_lstat.st_uid != os.geteuid() or stat.S_IMODE(parent_lstat.st_mode) != 0o700):
        raise ValueError("insecure_forward_parent")
    return path

def _socket_identity(path: Path) -> dict | None:
    """Return a stable identity for an owned pathname; never follow links."""
    try:
        row = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RuntimeError("forward_socket_observation_unavailable") from exc
    if not stat.S_ISSOCK(row.st_mode) or row.st_uid != os.geteuid():
        raise RuntimeError("unexpected_forward_socket_path")
    return {"device": row.st_dev, "inode": row.st_ino, "uid": row.st_uid,
            "file_type": stat.S_IFMT(row.st_mode)}

def validate_forward_resource(serial: str, local: str, remote: str) -> None:
    if not isinstance(serial, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:\[\]-]{0,199}", serial):
        raise ValueError("invalid_forward_serial")
    match = re.fullmatch(r"tcp:(0|[1-9]\d{0,4})", local) if isinstance(local, str) else None
    socket_path = _cellular_socket_path(local)
    if match:
        if not 0 <= int(match[1]) <= 65535:
            raise ValueError("invalid_forward_local")
    elif socket_path is None:
        raise ValueError("invalid_forward_local")
    tcp = re.fullmatch(r"tcp:([1-9]\d{0,4})", remote) if isinstance(remote, str) else None
    unix = re.fullmatch(r"localabstract:[A-Za-z0-9_.:-]{1,200}", remote) if isinstance(remote, str) else None
    if socket_path is not None and remote != CELLULAR_FORWARD_REMOTE:
        raise ValueError("unsupported_forward_remote")
    if socket_path is None and not unix and not (tcp and 1 <= int(tcp[1]) <= 65535):
        raise ValueError("unsupported_forward_remote")

def forward_state(serial: str) -> list[dict]:
    # --list is server-wide, even when -s is supplied. Retain all identities.
    text = adb("forward", "--list", serial=serial, check=True).stdout
    result = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 3 or len(result) >= 1000:
            raise RuntimeError("invalid_forward_observation")
        result.append(dict(zip(("serial", "local", "remote"), fields)))
    return result

def _forward_at(rows: list[dict], local: str) -> list[dict]:
    return [item for item in rows if item["local"] == local]

def _forward_save(path: Path, row: dict, state: str, reason: str, **extra) -> None:
    row.update(state=state, reason=reason, updated_at=time.time(), **extra)
    events = row.setdefault("events", [])
    events.append({"at": row["updated_at"], "state": state, "reason": reason})
    if len(events) > 64:
        row["events"] = events[:1] + events[-63:]
        row["events_truncated"] = True
    write_json(path, row)

def _forward_load(path: Path) -> dict:
    if path.is_symlink():
        raise ValueError("invalid_forward_lease_path")
    row = json.loads(path.read_text())
    if row.get("type") != "adb_forward" or row.get("lease_id") != path.stem:
        raise ValueError("invalid_forward_lease_type")
    resource = row["resource"]
    validate_forward_resource(resource["serial"], resource["local"], resource["remote"])
    return row

def _forward_expired(row: dict) -> bool:
    return time.time() - float(row.get("last_renewed_at", row["created_at"])) > MAX_LEASE_AGE

def _forward_result(row: dict, observed: list[dict] | None = None) -> dict:
    resource = row["resource"]
    if observed is None:
        observed = row.get("observed_after")
    matches = observed == [resource]
    socket_path = _cellular_socket_path(resource["local"])
    socket_matches = True
    if socket_path is not None:
        try:
            identity = _socket_identity(socket_path)
            socket_matches = identity is not None and row.get("socket_identity") == identity
        except RuntimeError:
            socket_matches = False
    owner_state = forward_owner_state(row)
    ready = (row["state"] in {"ACTIVE", "REUSED"} and matches and socket_matches and owner_state == "ALIVE"
             and not _forward_expired(row) and row.get("ownership_lost") is not True)
    return {"lease_id": row["lease_id"], "lease_path": str(forward_lease_path(row["lease_id"])),
            "type": "adb_forward", "state": row["state"], "reason": row.get("reason"), **resource,
            "ready": ready, "verified": ready or row.get("cleanup_verified") is True,
            "created": row.get("ownership_proven") is True, "reused": row.get("reused") is True,
            "mutation_dispatched": row.get("mutation_dispatched", False),
            "ownership_lost": row.get("ownership_lost", False), "restored_exact": row.get("restored_exact"),
            "cleanup_verified": row.get("cleanup_verified", False),
            "observed_matches": matches and socket_matches, "owner_alive": owner_state == "ALIVE", "owner_state": owner_state,
            "ttl_seconds": MAX_LEASE_AGE, "last_renewed_at": row.get("last_renewed_at"),
            "endpoint": ({"type": "unix", "socket_path": str(socket_path)} if socket_path is not None
                         else "http://127.0.0.1:" + resource["local"].split(":", 1)[1]) if ready else None}

def _forward_matches(row: dict, observed: list[dict]) -> bool:
    if observed != [row["resource"]]:
        return False
    path = _cellular_socket_path(row["resource"]["local"])
    if path is None:
        return True
    try:
        identity = _socket_identity(path)
    except RuntimeError:
        return False
    return identity is not None and row.get("socket_identity") == identity

def _forward_observe(row: dict) -> list[dict]:
    if row.get("adb_server") != forward_server_identity():
        raise RuntimeError("adb_server_identity_changed")
    resource = row["resource"]
    return _forward_at(forward_state(resource["serial"]), resource["local"])

def _forward_inspect(path: Path, row: dict) -> dict:
    try:
        after = _forward_observe(row)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        return {**_forward_result(row, []), "ready": False, "verified": False, "reason": "forward_observation_unavailable"}
    if (row["state"] not in {"CLOSED", "BLOCKED", "PRESERVED"}
            and (row.get("ownership_proven") is True or row.get("reused") is True)
            and not _forward_matches(row, after)):
        _forward_save(path, row, "VERIFY_REQUIRED", "forward_mapping_changed", observed_after=after,
                      ownership_lost=row.get("ownership_proven") is True)
    return _forward_result(row, after)

def acquire_adb_forward(serial: str, local: str = "tcp:0", remote: str = "localabstract:chrome_devtools_remote",
                        purpose: str = "temporary-adb-forward", owner_pid: int | None = None,
                        lease_id: str | None = None) -> dict:
    """Acquire once. A stable caller-provided lease_id makes retries observational.

    tcp:0 selects/reserves a concrete local port BEFORE the durable lease and
    --no-rebind command. The lease never guesses a port from a lost ADB reply.
    An existing unique matching TCP forward is reused without taking ownership.
    """
    validate_forward_resource(serial, local, remote)
    owner_pid = os.getpid() if owner_pid is None else owner_pid
    if isinstance(owner_pid, bool) or not isinstance(owner_pid, int) or owner_pid <= 0:
        raise ValueError("invalid_forward_owner_pid")
    owner = process_identity(owner_pid)
    if owner is None:
        raise ValueError("forward_owner_not_alive")
    lease_id = uuid.uuid4().hex if lease_id is None else lease_id
    path = forward_lease_path(lease_id)
    request = {"serial": serial, "local": local, "remote": remote, "owner_pid": owner_pid, "owner_identity": owner}
    with mutation_lock():
        if path.exists():
            row = _forward_load(path)
            if row.get("request") != request:
                raise ValueError("forward_lease_identity_conflict")
            return _forward_inspect(path, row)
        rows = forward_state(serial)
        reservation = None
        ambiguous = False
        if local == "tcp:0":
            existing = [item for item in rows if item["serial"] == serial and item["remote"] == remote and re.fullmatch(r"tcp:[1-9]\d{0,4}", item["local"])]
            if len(existing) == 1:
                local = existing[0]["local"]
            elif len(existing) > 1:
                ambiguous = True
            else:
                reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                reservation.bind(("127.0.0.1", 0))
                local = "tcp:" + str(reservation.getsockname()[1])
        resource = {"serial": serial, "local": local, "remote": remote}
        socket_path = _cellular_socket_path(local)
        before = _forward_at(rows, local)
        row = {"schema_version": 2, "type": "adb_forward", "lease_id": lease_id,
               "created_at": time.time(), "last_renewed_at": time.time(), "owner_pid": owner_pid,
               "owner_identity": owner, "purpose": str(purpose)[:240], "request": request,
               "resource": resource, "adb_server": forward_server_identity(), "before": before,
               "ownership_proven": False, "ownership_lost": False, "mutation_dispatched": False,
               "reused": False, "renewals": 0}
        try:
            _forward_save(path, row, "PREPARED", "exact_snapshot_durable_before_mutation")
            if socket_path is not None and os.path.lexists(socket_path) and before != [resource]:
                _forward_save(path, row, "BLOCKED", "unexpected_forward_socket_path", observed_after=before,
                              cleanup_verified=True, restored_exact=True)
            elif socket_path is not None and before == [resource]:
                try:
                    row["socket_identity"] = _socket_identity(socket_path)
                except RuntimeError:
                    row["socket_identity"] = None
                if row["socket_identity"] is None:
                    _forward_save(path, row, "BLOCKED", "preexisting_forward_socket_unverified", observed_after=before,
                                  cleanup_verified=True, restored_exact=True)
                else:
                    _forward_save(path, row, "REUSED", "preexisting_forward_not_owned", reused=True, observed_after=before)
            elif ambiguous:
                _forward_save(path, row, "BLOCKED", "multiple_preexisting_forwards", observed_after=before,
                              cleanup_verified=True, restored_exact=True)
            elif before:
                if before == [resource]:
                    _forward_save(path, row, "REUSED", "preexisting_forward_not_owned", reused=True, observed_after=before)
                else:
                    _forward_save(path, row, "BLOCKED", "preexisting_local_preserved", observed_after=before,
                                  cleanup_verified=True, restored_exact=True)
            else:
                _forward_save(path, row, "CREATE_REQUESTED", "forward_creation_dispatched_once", mutation_dispatched=True)
                if reservation is not None:
                    reservation.close()
                    reservation = None
                try:
                    outcome = adb("forward", "--no-rebind", local, remote, serial=serial)
                except (OSError, subprocess.SubprocessError) as exc:
                    _forward_save(path, row, "VERIFY_REQUIRED", "forward_creation_result_unknown", command_error=type(exc).__name__)
                else:
                    if outcome.returncode == 0:
                        _forward_save(path, row, "CREATE_ACKNOWLEDGED", "forward_creation_acknowledged",
                                      ownership_proven=True, create_returncode=0)
                    else:
                        _forward_save(path, row, "VERIFY_REQUIRED", "forward_creation_not_acknowledged", create_returncode=outcome.returncode)
                try:
                    after = _forward_observe(row)
                except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                    _forward_save(path, row, "VERIFY_REQUIRED", "forward_post_observation_unavailable", observation_error=type(exc).__name__)
                else:
                    if socket_path is not None:
                        try:
                            row["socket_identity"] = _socket_identity(socket_path)
                        except RuntimeError:
                            row["socket_identity"] = None
                    if row.get("ownership_proven") is True and _forward_matches(row, after):
                        _forward_save(path, row, "ACTIVE", "owned_forward_verified", observed_after=after)
                    else:
                        _forward_save(path, row, "VERIFY_REQUIRED", "forward_creation_requires_verification", observed_after=after,
                                      ownership_lost=row.get("ownership_proven") is True and after != [resource])
            return _forward_result(row)
        finally:
            if reservation is not None:
                reservation.close()

def inspect_adb_forward(lease_id: str) -> dict:
    """Observe mapping and journal divergence; never create/remove a forward."""
    with mutation_lock():
        path = forward_lease_path(lease_id)
        return _forward_inspect(path, _forward_load(path))

def renew_adb_forward(lease_id: str, owner_pid: int | None = None) -> dict:
    """Renew from the live worker between bounded steps; no scheduler is added."""
    with mutation_lock():
        path = forward_lease_path(lease_id)
        row = _forward_load(path)
        owner_pid = os.getpid() if owner_pid is None else owner_pid
        if owner_pid != row["owner_pid"] or not lease_alive(row):
            raise ValueError("forward_lease_owner_mismatch")
        if row["state"] not in {"ACTIVE", "REUSED"} or _forward_expired(row):
            return {**_forward_result(row, []), "ready": False, "verified": False, "reason": "forward_lease_not_renewable"}
        try:
            after = _forward_observe(row)
        except (OSError, RuntimeError, subprocess.SubprocessError):
            return {**_forward_result(row, []), "ready": False, "verified": False, "reason": "forward_observation_unavailable"}
        if not _forward_matches(row, after):
            _forward_save(path, row, "VERIFY_REQUIRED", "forward_changed_before_renewal", observed_after=after,
                          ownership_lost=row.get("ownership_proven") is True)
        else:
            row.update(last_renewed_at=time.time(), renewals=row.get("renewals", 0) + 1, observed_after=after)
            write_json(path, row)
        return _forward_result(row, after)

def _cleanup_owned_socket_path(row: dict) -> bool:
    """Remove only the exact Unix socket inode created for this owned forward."""
    path = _cellular_socket_path(row["resource"]["local"])
    if path is None:
        return True
    try:
        current = _socket_identity(path)
    except RuntimeError:
        return False
    if current is None:
        return True
    if row.get("socket_identity") != current:
        return False
    try:
        path.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return not os.path.lexists(path)

def _release_adb_forward(path: Path, row: dict) -> dict:
    """Under mutation_lock; unknown ownership never authorizes --remove."""
    if row["state"] in {"CLOSED", "BLOCKED"}:
        return _forward_result(row)
    try:
        current = _forward_observe(row)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        _forward_save(path, row, "VERIFY_REQUIRED", "forward_cleanup_observation_unavailable", observation_error=type(exc).__name__)
        return _forward_result(row, [])
    if row.get("reused") is True:
        same = current == row["before"] and _forward_matches(row, current)
        _forward_save(path, row, "CLOSED" if same else "PRESERVED", "preexisting_forward_preserved" if same else "preexisting_forward_changed_externally",
                      observed_after=current, cleanup_verified=same, restored_exact=same)
    elif not current:
        cleaned = _cleanup_owned_socket_path(row)
        _forward_save(path, row, "CLOSED" if cleaned else "PRESERVED",
                      "forward_absence_observed" if cleaned else "forward_socket_changed_externally",
                      observed_after=[], cleanup_verified=cleaned, restored_exact=cleaned and row["before"] == [],
                      ownership_lost=not cleaned)
    elif not _forward_matches(row, current) or row.get("ownership_lost") is True or row["state"] == "PRESERVED":
        _forward_save(path, row, "PRESERVED", "repointed_or_foreign_forward_preserved", observed_after=current,
                      cleanup_verified=False, restored_exact=False, ownership_lost=True)
    elif row.get("ownership_proven") is not True or row.get("before") != []:
        _forward_save(path, row, "VERIFY_REQUIRED", "forward_ownership_not_proven", observed_after=current, cleanup_verified=False)
    elif row.get("remove_dispatched") is True:
        _forward_save(path, row, "VERIFY_REQUIRED", "prior_forward_remove_result_unknown", observed_after=current, cleanup_verified=False)
    else:
        # ADB removal accepts only LOCAL, not a compare-and-delete tuple. Guard
        # users share this lock; fresh full identity is mandatory before removal.
        _forward_save(path, row, "REMOVE_REQUESTED", "owned_forward_cleanup_dispatched_once",
                      observed_before_cleanup=current, remove_dispatched=True)
        try:
            outcome = adb("forward", "--remove", row["resource"]["local"], serial=row["resource"]["serial"])
            row["remove_returncode"] = outcome.returncode
        except (OSError, subprocess.SubprocessError) as exc:
            row["remove_error"] = type(exc).__name__
        try:
            after = _forward_observe(row)
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            _forward_save(path, row, "VERIFY_REQUIRED", "forward_cleanup_post_observation_unavailable", observation_error=type(exc).__name__)
        else:
            if not after:
                cleaned = _cleanup_owned_socket_path(row)
                _forward_save(path, row, "CLOSED" if cleaned else "PRESERVED",
                              "owned_forward_removal_verified" if cleaned else "forward_socket_cleanup_not_verified",
                              observed_after=after, cleanup_verified=cleaned, restored_exact=cleaned,
                              ownership_lost=not cleaned)
            elif after != [row["resource"]]:
                _forward_save(path, row, "PRESERVED", "forward_changed_during_cleanup_preserved", observed_after=after,
                              cleanup_verified=False, restored_exact=False, ownership_lost=True)
            else:
                _forward_save(path, row, "VERIFY_REQUIRED", "forward_cleanup_not_verified", observed_after=after, cleanup_verified=False)
    return _forward_result(row)

def release_adb_forward(lease_id: str, owner_pid: int | None = None) -> dict:
    with mutation_lock():
        path = forward_lease_path(lease_id)
        row = _forward_load(path)
        owner_pid = os.getpid() if owner_pid is None else owner_pid
        owner_state = forward_owner_state(row)
        if owner_state == "UNKNOWN":
            return {**_forward_result(row, []), "ready": False, "verified": False, "reason": "forward_owner_identity_unavailable"}
        if owner_state == "ALIVE" and owner_pid != row["owner_pid"]:
            raise ValueError("forward_lease_owner_mismatch")
        return _release_adb_forward(path, row)

def write_receipt(state: str, reason: str, **extra) -> None:
    write_json(RECEIPT, {
        "schema_version": 1,
        "checked_at": time.time(),
        "state": state,
        "reason": reason,
        **extra,
    })

def check_and_reconcile(reconcile_background: bool = True) -> int:
    active = []
    active_proxy = []
    recovered = []
    forward_results = []
    errors = []
    active_wifi = []
    now = time.time()
    with mutation_lock():
        LEASES.mkdir(parents=True, exist_ok=True)
        for lease in sorted(LEASES.glob("*.json")):
            try:
                if lease.is_symlink():
                    raise ValueError("invalid_lease_path")
                row = json.loads(lease.read_text())
                kind = row.get("type", "global_proxy")
                if kind == "adb_forward":
                    row = _forward_load(forward_lease_path(lease.stem))
                    if row["state"] in {"CLOSED", "BLOCKED"}:
                        continue  # Retain the existing lease as its bounded journal.
                    owner_state = forward_owner_state(row)
                    if owner_state == "UNKNOWN":
                        errors.append({"lease": lease.name, "error": "forward_owner_identity_unavailable"})
                        continue
                    if owner_state == "ALIVE" and not _forward_expired(row):
                        result = _forward_inspect(lease, row)
                        forward_results.append(result)
                        if result["ready"]:
                            active.append(lease.name)
                        else:
                            errors.append({"lease": lease.name, "error": result["reason"]})
                        continue
                    result = _release_adb_forward(lease, row)
                    forward_results.append(result)
                    if result["cleanup_verified"]:
                        recovered.append(lease.name)
                    else:
                        errors.append({"lease": lease.name, "error": result["reason"]})
                    continue
                if kind not in {"global_proxy", "wifi_off"}:
                    raise ValueError("unsupported_network_lease_type")
                if lease_alive(row) and not lease_expired(row, now):
                    active.append(lease.name)
                    if kind == "global_proxy":
                        active_proxy.append(lease.name)
                    else:
                        active_wifi.append(lease.name)
                    continue
                cause = "ttl_expired" if lease_expired(row, now) else "owner_dead"
                restore_lease(row)
                lease.unlink()
                recovered.append(lease.name)
                log_line(f"service=network_safety action=stale_lease_restored lease={lease.name} type={kind} "
                         f"purpose={_safe_token(row.get('purpose'))} cause={cause} "
                         f"wifi_initially_enabled={bool(row.get('wifi_enabled')) if kind == 'wifi_off' else 'na'}")
            except Exception as exc:
                errors.append({"lease": lease.name, "error": type(exc).__name__})
    current = settings_state()
    unmanaged = proxy_active(current) and not active_proxy
    warnings = []
    if not active_wifi:
        # Wi-Fi coupé sans bail : peut être le choix d'Amine. Jamais de réactivation automatique,
        # seulement un avertissement exposé dans le reçu (et le verdict santé).
        try:
            if wifi_enabled() is False:
                warnings.append(WIFI_UNMANAGED_WARNING)
        except Exception:
            pass
    if errors:
        write_receipt("degraded", "stale_lease_restore_failed", active_leases=active, errors=errors,
                      forward_leases=forward_results, unmanaged_global_proxy=unmanaged, warnings=warnings)
        return 2
    if unmanaged:
        write_receipt("degraded", "unmanaged_global_proxy_detected", active_leases=active, warnings=warnings)
        return 2
    background = {"state": "skipped", "mutation": "none", "details": {}}
    if reconcile_background:
        try:
            background = ensure_termux_background_network()
        except Exception as exc:
            write_receipt("degraded", "termux_background_policy_repair_failed", active_leases=active, error=type(exc).__name__)
            return 2
    if background.get("mutation") == "repaired":
        reason = "termux_background_policy_repaired"
    else:
        reason = "temporary_lease_active" if active else ("stale_lease_restored" if recovered else "network_settings_clean")
    write_receipt("healthy", reason, active_leases=active, recovered_leases=recovered,
                  forward_leases=forward_results, termux_background=background, warnings=warnings)
    return 0

def with_global_proxy(endpoint: str, purpose: str, command: list[str]) -> int:
    lease = create_lease(purpose)
    row = json.loads(lease.read_text())
    restore_error = None
    def interrupted(_sig, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        adb("shell", "settings", "put", "global", "http_proxy", endpoint, check=True)
        child = subprocess.run(command)
        return child.returncode
    finally:
        try:
            restore_lease(row)
            lease.unlink(missing_ok=True)
            write_receipt("healthy", "temporary_proxy_restored")
        except Exception as exc:
            restore_error = type(exc).__name__
            write_receipt("degraded", "temporary_proxy_restore_failed", lease=lease.name, error=restore_error)
        if restore_error:
            raise RuntimeError("temporary_proxy_restore_failed")

def _stop_child(child: subprocess.Popen) -> None:
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=CHILD_STOP_GRACE_S)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()

def run_while_wifi_stays_off(command: list[str], *, interval_s: float = WIFI_WATCH_INTERVAL_S,
                             sleep=time.sleep, deadline_s: float | None = None,
                             clock=time.monotonic) -> tuple[int, bool]:
    """Run the child while sampling Wi-Fi every interval. Returns (returncode, wifi_reenabled).

    An unreadable sample is not proof that Wi-Fi came back; only an explicit "enabled" stops the child.
    With deadline_s, a child still running at the lease deadline is stopped (WIFI_TTL_EXIT) so the guard
    restores before its lease expires."""
    child = subprocess.Popen(command)
    deadline = None if deadline_s is None else clock() + deadline_s
    try:
        while True:
            code = child.poll()
            if code is not None:
                return code, False
            if deadline is not None and clock() >= deadline:
                _stop_child(child)
                return WIFI_TTL_EXIT, False
            try:
                back = wifi_enabled()
            except (RuntimeError, OSError, subprocess.SubprocessError):
                back = False
            if back:
                _stop_child(child)
                return WIFI_REENABLED_EXIT, True
            sleep(interval_s)
    finally:
        _stop_child(child)

def _safe_token(value) -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", text) else "redacted"

def _blocked(reason: str) -> None:
    # Dernière ligne stdout = ce que chaque appelant analyse : blocage précis, sans prétention d'effet.
    print(json.dumps({"schemaVersion": 1, "state": "blocked", "reasonCode": reason}, separators=(",", ":")), flush=True)

def wifi_lease_path(value: str) -> Path:
    path = Path(value)
    if not re.fullmatch(r"[a-f0-9]{32}\.json", path.name) or path.is_symlink() or LEASES.is_symlink():
        raise ValueError("invalid_wifi_lease_path")
    if path.parent.resolve() != LEASES.resolve():
        raise ValueError("invalid_wifi_lease_path")
    return LEASES / path.name

def read_wifi_lease(lease: Path, token: str | None) -> dict | None:
    """The lease is the restoration contract; absent or owned by another token = nothing of ours to do."""
    try:
        row = json.loads(lease.read_text())
    except FileNotFoundError:
        return None
    if row.get("type") != "wifi_off" or row.get("owner_token") != token:
        return None
    return row

def _reconcile_stale_wifi_leases(now: float) -> list[str]:
    """Under mutation_lock: restore dead/expired wifi_off leases; return the live ones."""
    live = []
    LEASES.mkdir(parents=True, exist_ok=True)
    for lease in sorted(LEASES.glob("*.json")):
        if lease.is_symlink():
            continue
        try:
            row = json.loads(lease.read_text())
        except (OSError, ValueError):
            continue
        if row.get("type") != "wifi_off":
            continue
        if lease_alive(row) and not lease_expired(row, now):
            live.append(lease.name)
            continue
        restore_lease(row)
        lease.unlink(missing_ok=True)
        log_line(f"service=network_safety action=stale_lease_restored lease={lease.name} type=wifi_off "
                 f"purpose={_safe_token(row.get('purpose'))} cause=preflight_reconcile "
                 f"wifi_initially_enabled={bool(row.get('wifi_enabled'))}")
    return live

def spawn_restorer(lease: Path, token: str) -> bool:
    """Short-lived DETACHED restorer per lease: new session (setsid) then double fork, so neither the
    guard's death nor a bridge process-group/tree kill reaches it. No new store, no daemon."""
    try:
        p = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "wifi-restorer", str(lease), "--token", token],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=True, start_new_session=True, cwd=str(HOME))
        return p.wait(timeout=5) == 0  # the intermediate exits right after forking the restorer
    except (OSError, subprocess.SubprocessError):
        return False

def run_restorer(lease: Path, token: str, *, clock=time.time, sleep=time.sleep,
                 poll_s: float = RESTORER_POLL_S, attempts: int = RESTORER_ATTEMPTS,
                 retry_s: float = RESTORER_RETRY_S) -> str:
    """Wait until the lease is released (guard restored: nothing to do) or its owner is gone / TTL expired
    (restore exactly from the lease, under the shared guard.lock, then remove it)."""
    while True:
        row = read_wifi_lease(lease, token)
        if row is None:
            return "lease_released"
        if lease_expired(row, clock()) or not lease_alive(row):
            break
        remaining = float(row.get("expires_at", clock() + poll_s)) - clock()
        sleep(max(0.05, min(poll_s, remaining)))
    error = "unknown"
    for _ in range(max(1, attempts)):
        try:
            with mutation_lock(RESTORE_LOCK_TIMEOUT_S):
                row = read_wifi_lease(lease, token)
                if row is None:
                    return "lease_released"
                cause = "ttl_expired" if lease_expired(row, clock()) else "owner_dead"
                restore_lease(row)
                lease.unlink(missing_ok=True)
            write_receipt("healthy", "wifi_lease_restored_by_restorer", lease=lease.name, cause=cause,
                          wifi_initially_enabled=bool(row.get("wifi_enabled")), purpose=_safe_token(row.get("purpose")))
            log_line(f"service=network_safety action=wifi_lease_restored_by_restorer lease={lease.name} "
                     f"purpose={_safe_token(row.get('purpose'))} cause={cause} "
                     f"wifi_initially_enabled={bool(row.get('wifi_enabled'))}")
            return "restored"
        except Exception as exc:
            error = type(exc).__name__
            sleep(retry_s)
    # The lease stays: the Health Manager sweep (check) retries from the same durable contract.
    write_receipt("degraded", "wifi_restorer_restore_failed", lease=lease.name, error=error)
    log_line(f"service=network_safety action=wifi_restorer_restore_failed lease={lease.name} error={error}")
    return "failed"

def restorer_main(lease_arg: str, token: str) -> int:
    lease = wifi_lease_path(lease_arg)
    if os.fork() > 0:
        os._exit(0)
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, signal.SIG_IGN)
    try:
        run_restorer(lease, token)
    finally:
        os._exit(0)

def _run_without_mutation(purpose: str, command: list[str], decision: dict) -> int:
    write_receipt("healthy", "cellular_already_default", mutation="none", purpose=_safe_token(purpose),
                  network_decision=decision["detail"])
    if decision.get("wifi_enabled") is False:
        # Wi-Fi déjà coupé (pas par nous) : même surveillance qu'avant, aucune mutation.
        code, back = run_while_wifi_stays_off(command)
        if back:
            _blocked("wifi_reenabled")
        return code
    return subprocess.run(command).returncode

def with_wifi_off(purpose: str, command: list[str]) -> int:
    ttl_s = wifi_off_ttl(purpose)
    with mutation_lock():
        live = _reconcile_stale_wifi_leases(time.time())
        if live:
            # Garde concurrent : jamais de second instantané « Wi-Fi coupé » (cause probable du 11/10).
            write_receipt("healthy", "wifi_off_guard_busy", active_leases=live, purpose=_safe_token(purpose))
            _blocked("wifi_off_guard_busy")
            return WIFI_GUARD_BUSY_EXIT
        decision = wifi_toggle_decision()
        lease = None
        if decision["toggle"]:
            lease = create_lease(purpose, lease_type="wifi_off", include_wifi=True, ttl_s=ttl_s, decision=decision)
    if lease is None:
        return _run_without_mutation(purpose, command, decision)
    row = json.loads(lease.read_text())
    token = row.get("owner_token")
    if not spawn_restorer(lease, token):
        with mutation_lock(RESTORE_LOCK_TIMEOUT_S):
            lease.unlink(missing_ok=True)
        write_receipt("degraded", "wifi_restorer_unavailable", purpose=_safe_token(purpose))
        _blocked("wifi_restorer_unavailable")
        return WIFI_RESTORER_UNAVAILABLE_EXIT
    restore_error = None
    reenabled = False
    restored_by = "guard"
    code = None
    def interrupted(_sig, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        # Auto Wi-Fi first, so it cannot undo the toggle below. Lease (exact snapshot) is durable already.
        disable_auto_wifi(row["auto_wifi"])
        if row["wifi_enabled"] is True:
            set_wifi(False)
        deadline = max(1.0, float(row.get("expires_at", time.time() + ttl_s)) - time.time() - RESTORE_MARGIN_S)
        code, reenabled = run_while_wifi_stays_off(command, deadline_s=deadline)
        if reenabled:
            _blocked("wifi_reenabled")
        elif code == WIFI_TTL_EXIT:
            _blocked("wifi_off_ttl_expired")
        return code
    finally:
        # A second signal must not abort the restoration itself.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            with mutation_lock(RESTORE_LOCK_TIMEOUT_S):
                if read_wifi_lease(lease, token) is None:
                    restored_by = "restorer_or_sweep"  # already restored exactly from the lease: no double toggle
                else:
                    restore_lease(row)
                    lease.unlink(missing_ok=True)
            write_receipt("healthy", "temporary_wifi_restored", wifi_initially_enabled=bool(row["wifi_enabled"]),
                          auto_wifi_restored=True, wifi_reenabled_during_operation=reenabled,
                          mutation="wifi_off", network_decision=decision["detail"], restored_by=restored_by,
                          ttl_s=ttl_s)
        except Exception as exc:
            restore_error = type(exc).__name__
            write_receipt("degraded", "temporary_wifi_restore_failed", lease=lease.name, error=restore_error)
        if restore_error:
            raise RuntimeError("temporary_wifi_restore_failed")

def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("ensure-termux-background")
    s = sub.add_parser("snapshot")
    s.add_argument("--purpose", default="manual")
    r = sub.add_parser("restore")
    r.add_argument("lease")
    w = sub.add_parser("with-global-proxy")
    w.add_argument("endpoint")
    w.add_argument("--purpose", default="temporary-proxy")
    w.add_argument("command", nargs="+")
    wf = sub.add_parser("with-wifi-off")
    wf.add_argument("--purpose", default="temporary-wifi-off")
    wf.add_argument("command", nargs="+")
    wr = sub.add_parser("wifi-restorer")  # interne : lancé détaché par with-wifi-off
    wr.add_argument("lease")
    wr.add_argument("--token", required=True)
    fa = sub.add_parser("forward-acquire")
    fa.add_argument("--serial", required=True)
    fa.add_argument("--local", default="tcp:0")
    fa.add_argument("--remote", default="localabstract:chrome_devtools_remote")
    fa.add_argument("--purpose", default="temporary-adb-forward")
    fa.add_argument("--lease-id", required=True)
    fa.add_argument("--owner-pid", type=int, required=True)
    for command_name in ("forward-status", "forward-renew", "forward-release"):
        command_parser = sub.add_parser(command_name)
        command_parser.add_argument("lease_id")
        if command_name != "forward-status":
            command_parser.add_argument("--owner-pid", type=int, required=True)
    args = ap.parse_args()
    if args.cmd.startswith("forward-"):
        try:
            if args.cmd == "forward-acquire":
                result = acquire_adb_forward(args.serial, args.local, args.remote, args.purpose,
                                             args.owner_pid, args.lease_id)
            elif args.cmd == "forward-status":
                result = inspect_adb_forward(args.lease_id)
            elif args.cmd == "forward-renew":
                result = renew_adb_forward(args.lease_id, args.owner_pid)
            else:
                result = release_adb_forward(args.lease_id, args.owner_pid)
        except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, KeyError, TypeError) as exc:
            # No raw ADB stdout/stderr, environment or process identity is emitted.
            print(json.dumps({"type": "adb_forward", "state": "VERIFY_REQUIRED", "ready": False,
                              "verified": False, "error": type(exc).__name__}))
            return 2
        print(json.dumps(result, sort_keys=True))
        return 0 if (result["cleanup_verified"] if args.cmd == "forward-release" else result["ready"]) else 2
    if args.cmd == "wifi-restorer":
        return restorer_main(args.lease, args.token)
    if args.cmd == "check":
        return check_and_reconcile()
    if args.cmd == "ensure-termux-background":
        print(json.dumps(ensure_termux_background_network(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "snapshot":
        print(create_lease(args.purpose))
        return 0
    if args.cmd == "restore":
        lease = Path(args.lease)
        row = json.loads(lease.read_text())
        if row.get("type") == "adb_forward":
            if lease.resolve() != forward_lease_path(lease.stem).resolve():
                raise ValueError("invalid_forward_lease_path")
            result = release_adb_forward(lease.stem)
            print(json.dumps(result, sort_keys=True))
            return 0 if result["cleanup_verified"] else 2
        if row.get("type", "global_proxy") not in {"global_proxy", "wifi_off"}:
            raise ValueError("unsupported_network_lease_type")
        restore_lease(row)
        lease.unlink(missing_ok=True)
        write_receipt("healthy", "manual_restore_verified")
        return 0
    command = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if not command:
        raise SystemExit(f"{args.cmd} requires a command")
    if args.cmd == "with-wifi-off":
        return with_wifi_off(args.purpose, command)
    return with_global_proxy(args.endpoint, args.purpose, command)

if __name__ == "__main__":
    raise SystemExit(main())
