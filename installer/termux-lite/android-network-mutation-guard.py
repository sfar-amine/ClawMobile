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
import selectors
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
# O6 (fichier 37, décision du 11/10/2026) : borne totale d'une consultation gardée, de l'appel au reçu
# (verrou + préparation Wi-Fi + DNS + service + arrêt de l'enfant + restauration). Mesures S24
# (fixtures/s24-2026-10-11/o6-network-guard-timing.json) : entrée totale p50 5,6 s, p95 6,2 s, max 6,3 s.
# 60 s << MAX_LEASE_AGE (900 s) : le bail reste vivant sans renouvellement jusqu'à la restauration.
CONSULTATION_TOTAL_S = 60.0
_CONSULTATION_DEADLINE: float | None = None
# Tenu hors de l'enfant pour restaurer dans la borne : arrêt du groupe (TERM 0,5 s + KILL 1 s),
# réglages et Wi-Fi (set_wifi 8 s) et vérification adb (6 s).
CONSULTATION_RESTORE_RESERVE_S = 16.0
TERMUX_PACKAGES = ("com.termux", "com.termux.api", "com.termux.boot")
CELLULAR_FORWARD_REMOTE_PREFIX = "localabstract:ai.samantha.cellular."
CELLULAR_SOCKET_RE = re.compile(r"samantha-cellular-([a-f0-9]{32})\.sock")
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
    if _CONSULTATION_DEADLINE is not None:
        remaining = _CONSULTATION_DEADLINE-time.monotonic()
        if remaining <= 0:
            raise RuntimeError("consultation_total_bound_exceeded")
        timeout=min(timeout,remaining)
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
    if _CONSULTATION_DEADLINE is not None:
        deadline=min(deadline,_CONSULTATION_DEADLINE)
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
    consultation = isinstance(row.get("consultation_decision"),dict)
    if consultation and row.get("consultation_wifi_toggled") is not True:
        if not consultation_postcondition(row):
            raise RuntimeError("consultation_network_postcondition_changed")
        return
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
    if consultation and not consultation_postcondition(row,wait=True):
        raise RuntimeError("consultation_network_postcondition_unverified")

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
                 ttl_s: int | None = None, decision: dict | None = None, snapshot: dict | None = None) -> Path:
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
        "settings": snapshot["settings"] if snapshot is not None else settings_state(),
    }
    if include_wifi:
        # Format existant étendu (schema 2) : TTL, échéance, jeton propriétaire, identité du garde.
        row["wifi_enabled"] = snapshot["wifi_enabled"] if snapshot is not None else wifi_enabled()
        row["auto_wifi"] = snapshot["auto_wifi"] if snapshot is not None else auto_wifi_state()
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
def mutation_lock(timeout_s: float = 5.0, *, allow_consultation_delegate: bool = False):
    """Serialize mutations and reconciliation in this existing authority."""
    pointer = os.environ.get("SAMANTHA_MAXIT_LEASE_ID")
    if allow_consultation_delegate and pointer:
        _row, inherited_fd = _consultation_inherited_fd(pointer)
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                # POSIX byte lock serializes sibling helpers; the inherited FLOCK excludes all external actors.
                fcntl.lockf(inherited_fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, 0, os.SEEK_SET)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("network_mutation_guard_busy")
                time.sleep(0.025)
        try:
            _consultation_inherited_fd(pointer)  # Owner must still be alive after a wait.
            yield inherited_fd
        finally:
            fcntl.lockf(inherited_fd, fcntl.LOCK_UN, 1, 0, os.SEEK_SET)
        return
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
        yield fd
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
    suffix = CELLULAR_SOCKET_RE.fullmatch(socket_path.name)[1] if socket_path is not None else None
    if socket_path is not None and remote != CELLULAR_FORWARD_REMOTE_PREFIX + suffix:
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

def _recover_localfilesystem_ownership(path: Path, row: dict, observed: list[dict]) -> bool:
    """Prove the unique Unix effect after a lost ADB reply; TCP stays fail-closed."""
    socket_path = _cellular_socket_path(row["resource"]["local"])
    unknown_result = row.get("state") == "CREATE_REQUESTED" or bool(row.get("command_error"))
    if (socket_path is None or row.get("ownership_proven") is True or row.get("before") != []
            or row.get("mutation_dispatched") is not True or observed != [row["resource"]]
            or row.get("ownership_lost") is True or not unknown_result):
        return False
    try:
        identity = _socket_identity(socket_path)
    except RuntimeError:
        return False
    if identity is None:
        return False
    row.update(socket_identity=identity, ownership_proven=True)
    _forward_save(path, row, "OWNERSHIP_RECOVERED", "unique_localfilesystem_effect_observed",
                  observed_after=observed)
    return True

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
    with mutation_lock(allow_consultation_delegate=True):
        pointer = os.environ.get("SAMANTHA_MAXIT_LEASE_ID")
        consultation = None
        if pointer:
            consultation,_fd = _consultation_inherited_fd(pointer)
            context = consultation_context(pointer)
            socket_path = _cellular_socket_path(local)
            if (context.get("verified") is not True or context.get("route") != "cellular_bound_wifi_unchanged"
                    or purpose != "orange-cellular-channel" or serial != ADB_ENDPOINT or socket_path is None
                    or CELLULAR_SOCKET_RE.fullmatch(socket_path.name)[1] != lease_id
                    or remote != CELLULAR_FORWARD_REMOTE_PREFIX+lease_id
                    or not _process_descends_from(owner_pid,consultation["owner_pid"])
                    or not _process_descends_from(os.getpid(),owner_pid)
                    or consultation.get("consultation_forward_lease_id") not in (None,lease_id)):
                raise RuntimeError("channel_forward_admission_invalid")
            consultation["consultation_forward_lease_id"] = lease_id
            write_json(forward_lease_path(pointer),consultation)
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
        if consultation is not None:
            row["consultation_lease_id"] = pointer
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
                _forward_save(path, row, "BLOCKED", "preexisting_localfilesystem_forward_preserved",
                              observed_after=before, cleanup_verified=True, restored_exact=True)
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
                        unknown_result = row.get("state") == "CREATE_REQUESTED" or bool(row.get("command_error"))
                        if (row.get("ownership_proven") is not True and unknown_result and row.get("before") == []
                                and row.get("mutation_dispatched") is True and after == [resource]
                                and row["socket_identity"] is not None):
                            row["ownership_proven"] = True
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
    with mutation_lock(allow_consultation_delegate=True):
        path = forward_lease_path(lease_id)
        return _forward_inspect(path, _forward_load(path))

def renew_adb_forward(lease_id: str, owner_pid: int | None = None) -> dict:
    """Renew from the live worker between bounded steps; no scheduler is added."""
    with mutation_lock(allow_consultation_delegate=True):
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
    _recover_localfilesystem_ownership(path, row, current)
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
    with mutation_lock(allow_consultation_delegate=True):
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

CONSULTATION_OPTIONS = ("--no-cellular-channel", "--keep-wifi")


def canonical_consultation_argv(argv: list[str], exe: str) -> bool:
    """The exact guard command line, each consultation option at most once and in any order.
    S24 18/10 14:53: the live-voice `--keep-wifi` (17/10) was missing here, so every voice Orange
    consultation stopped at guard_unavailable before any network action."""
    try:
        options = []
        rest = argv[3:]
        while rest and rest[0] in CONSULTATION_OPTIONS and rest[0] not in options:
            options.append(rest[0]); rest = rest[1:]
        argv = argv[:3] + rest
        return (len(argv) >= 8 and Path(argv[1]).is_absolute()
                and Path(argv[1]).resolve() == Path(__file__).resolve()
                and Path(exe).resolve() == Path(sys.executable).resolve()
                and argv[2:4] == ["with-consultation-receipt", "--"]
                and Path(argv[4]).resolve() == Path(sys.executable).resolve()
                and argv[5:7] == ["-m", "telecom.maxit_guarded_service"])
    except (OSError, ValueError, IndexError):
        return False


def canonical_consultation_owner(pid: int) -> bool:
    """A birth identity alone cannot turn an ordinary Python process into the guard."""
    try:
        proc = Path("/proc") / str(pid)
        raw = (proc / "cmdline").read_bytes()
        if len(raw) > 8192:
            return False
        argv = [v.decode() for v in raw.rstrip(b"\0").split(b"\0")]
        return canonical_consultation_argv(argv, os.readlink(proc / "exe"))
    except (OSError, ValueError, IndexError, UnicodeError):
        return False




class ConsultationChildFailure(RuntimeError):
    def __init__(self, reason: str, cleanup_verified: bool):
        super().__init__(reason)
        self.cleanup_verified = cleanup_verified


def consultation_group_members(pgid: int) -> list[int] | None:
    """Observe our own process group, ignoring dead zombies, fail closed on ambiguity."""
    members = []
    try:
        count = 0
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            count += 1
            if count > 65536:
                return None
            try:
                # Filter by the kernel group id before reading unrelated process details.
                if os.getpgid(int(entry.name)) != pgid:
                    continue
                if entry.stat().st_uid != os.getuid():
                    return None
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                if int(fields[2]) == pgid and fields[0] != "Z":
                    members.append(int(entry.name))
            except (FileNotFoundError, ProcessLookupError):
                continue
            except (OSError, ValueError, IndexError):
                return None
        return members
    except OSError:
        return None


def _stop_consultation_group_id(pgid: int, child: subprocess.Popen | None = None) -> bool:
    for sig, grace in ((signal.SIGTERM,0.5),(signal.SIGKILL,1.0)):
        try:
            os.killpg(pgid,sig)
        except ProcessLookupError:
            pass
        except OSError:
            return False
        deadline=time.monotonic()+grace
        while True:
            if child is not None:
                child.poll()
            members=consultation_group_members(pgid)
            if members==[]:
                if child is not None:
                    try:
                        child.wait(timeout=.2)
                    except subprocess.TimeoutExpired:
                        return False
                return True
            if time.monotonic()>=deadline:
                break
            time.sleep(.01)
    return False


def stop_consultation_group(child: subprocess.Popen) -> bool:
    return _stop_consultation_group_id(child.pid,child)


def stop_orphan_consultation_child(row: dict) -> bool:
    """Existing restorer stops its journalled child BEFORE waiting for an inherited flock."""
    child=row.get('consultation_child')
    if child is None:
        # The startup pipe cannot admit a module before its child identity is durable.
        return True
    if not isinstance(child,dict) or type(child.get('pid')) is not int or child.get('pgid')!=child['pid'] or child['pid']<=1:
        return False
    observed=process_identity(child['pid'])
    if observed is None:
        return consultation_group_members(child['pid'])==[]
    if observed!=child.get('identity'):
        return False  # A reused PID never authorizes killing the new process or its group.
    try:
        if os.getpgid(child['pid'])!=child['pgid']:
            return False
    except OSError:
        return consultation_group_members(child['pid'])==[]
    return _stop_consultation_group_id(child['pgid'])


def collect_consultation_child(command: list[str], env: dict, timeout_s: float = CONSULTATION_TOTAL_S - CONSULTATION_RESTORE_RESERVE_S) -> subprocess.CompletedProcess:
    """Bound BOTH output streams while reading, and kill all group members before return."""
    # Selector construction precedes launch: descriptor exhaustion cannot strand a child.
    selector = selectors.DefaultSelector()
    pointer=env.get("SAMANTHA_MAXIT_LEASE_ID")
    ready_read=ready_write=None
    launch=command
    inherited=(int(env["SAMANTHA_MAXIT_GUARD_LOCK_FD"]),) if env.get("SAMANTHA_MAXIT_GUARD_LOCK_FD") else ()
    try:
        if pointer:
            row=_consultation_row(pointer)
            if row is None or row["owner_pid"]!=os.getpid() or not inherited:
                raise RuntimeError("maxit_guard_required")
            ready_read,ready_write=os.pipe()
            # EOF closes every inherited descriptor if the parent dies before its durable READY.
            barrier="import os,sys;f=int(sys.argv[1]);r=os.read(f,1);os.close(f);sys.exit(125) if r!=b'1' else os.execv(sys.executable,[sys.executable,*sys.argv[2:]])"
            launch=[sys.executable,"-c",barrier,str(ready_read),*command[1:]]
            inherited=(*inherited,ready_read)
        child = subprocess.Popen(launch, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True,
                                 pass_fds=inherited)
    except BaseException:
        selector.close()
        for fd in (ready_read,ready_write):
            if fd is not None:
                os.close(fd)
        raise
    if ready_read is not None:
        os.close(ready_read)
    stdout = bytearray()
    total = 0
    failure = None
    deadline = time.monotonic() + timeout_s
    try:
        if pointer:
            identity=process_identity(child.pid)
            if identity is None or os.getpgid(child.pid)!=child.pid:
                raise ValueError("consultation_child_identity_unavailable")
            row["consultation_child"]={"pid":child.pid,"pgid":child.pid,"identity":identity}
            write_json(forward_lease_path(pointer),row)
            os.write(ready_write,b"1")
            os.close(ready_write);ready_write=None
        for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout_s)
            for key, _ in selector.select(min(remaining, 0.1)):
                data = os.read(key.fd, min(65536, 1048577 - total))
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                total += len(data)
                if total > 1048576:
                    raise ValueError("consultation_output_limit")
                if key.data == "stdout":
                    stdout.extend(data)
        child.wait(timeout=max(0.001, deadline-time.monotonic()))
    except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
        failure = type(exc).__name__
    finally:
        if ready_write is not None:
            os.close(ready_write)
        selector.close()
        # A second ordinary termination signal cannot interrupt cleanup certification.
        handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            cleanup_verified = stop_consultation_group(child)
        except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
            cleanup_verified = False
        finally:
            for stream in (child.stdout, child.stderr):
                stream.close()
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    if failure or not cleanup_verified:
        if not cleanup_verified:
            reason = "child_cleanup_unverified"
        elif failure == "TimeoutExpired":
            reason = "consultation_total_bound_exceeded"
        else:
            reason = "child_execution_failed"
        raise ConsultationChildFailure(reason, cleanup_verified)
    try:
        text = stdout.decode("utf-8")
    except UnicodeError:
        raise ConsultationChildFailure("child_output_invalid", True) from None
    return subprocess.CompletedProcess(command, child.returncode, text, "")


def _process_descends_from(pid: int, ancestor: int) -> bool:
    try:
        for _ in range(32):
            if pid == ancestor:
                return True
            proc = Path('/proc') / str(pid)
            if proc.stat().st_uid != os.geteuid():
                return False
            fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
            if fields[0] == 'Z':
                return False
            pid = int(fields[1])
            if pid <= 1:
                return False
    except (OSError, ValueError, IndexError):
        pass
    return False


def _guard_fd_is_locked(fd: int, owner: int, *, process: int | None = None) -> bool:
    """S24 fdinfo capture: an open pathname alone has no FLOCK WRITE line."""
    process = os.getpid() if process is None else process
    try:
        target = (ROOT / 'guard.lock').stat()
        proc_fd = Path('/proc') / str(process) / 'fd' / str(fd)
        observed = proc_fd.stat()
        if (not stat.S_ISREG(observed.st_mode) or observed.st_uid != os.geteuid()
                or (observed.st_dev, observed.st_ino) != (target.st_dev, target.st_ino)):
            return False
        info = (Path('/proc') / str(process) / 'fdinfo' / str(fd)).read_text()
        if len(info) > 8192:
            return False
        return any(re.fullmatch(r'lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+' + str(owner) + r'\s+\S+\s+0\s+EOF', line)
                   for line in info.splitlines())
    except (OSError, ValueError, TypeError):
        return False


def consultation_lock_owned(pid: int) -> bool:
    try:
        return any(fd.name.isdigit() and _guard_fd_is_locked(int(fd.name), pid, process=pid)
                   for fd in (Path('/proc') / str(pid) / 'fd').iterdir())
    except OSError:
        return False


def _consultation_row(lease_id: str) -> dict | None:
    if not isinstance(lease_id, str) or not re.fullmatch(r'[a-f0-9]{32}', lease_id):
        return None
    try:
        path = forward_lease_path(lease_id)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as source:
            meta = os.fstat(source.fileno())
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_size > 8192:
                return None
            raw = source.read(8193)
        if len(raw) > 8192:
            return None
        row = json.loads(raw)
        if not isinstance(row,dict) or type(row.get('schema_version')) is not int:
            return None
        owner = row.get('owner_pid')
        if (row.get('schema_version') not in (1, 2) or row.get('type') != 'wifi_off'
                or row.get('purpose') != 'maxit-deterministic'
                or type(owner) is not int or owner <= 0
                or not 0 <= time.time() - row['created_at'] <= MAX_LEASE_AGE
                or row.get('schema_version') == 2 and row.get('lease_id') != lease_id
                or not row.get('owner_identity') or process_identity(owner) != row['owner_identity']
                or not lease_alive(row) or not canonical_consultation_owner(owner)
                or not consultation_lock_owned(owner) or not _process_descends_from(os.getpid(), owner)):
            return None
        return row
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return None


def verify_consultation_lease(lease_id: str) -> bool:
    """The pointer confers no authority; current birth, ancestry and kernel FLOCK do."""
    return _consultation_row(lease_id) is not None


def _consultation_inherited_fd(lease_id: str) -> tuple[dict, int]:
    row = _consultation_row(lease_id)
    raw = os.environ.get('SAMANTHA_MAXIT_GUARD_LOCK_FD', '')
    if row is None or not re.fullmatch(r'[1-9][0-9]{0,6}', raw):
        raise RuntimeError('maxit_guard_required')
    fd = int(raw)
    if fd < 3 or not _guard_fd_is_locked(fd, row['owner_pid']):
        raise RuntimeError('maxit_guard_required')
    return row, fd


def parse_consultation_selection(raw: str, default_sub: str | None, subscriptions: str, wifi: bool) -> dict:
    """Pure projection of the captured Android formats; never persist raw dumps/identities."""
    denied = lambda reason: {'route': 'blocked', 'reason': reason, 'wifi_enabled': wifi}
    if len(raw.encode()) > 1048576 or len(subscriptions.encode()) > 1048576:
        return denied('network_observation_limit')
    if not isinstance(default_sub, str) or not re.fullmatch(r'\d{1,9}', default_sub):
        return denied('data_subscription_unknown')
    sub_id = int(default_sub)
    identities = set()
    for line in subscriptions.splitlines():
        if not any(token in line for token in ('SubscriptionInfo', 'mId=', ' id=')):
            continue
        values = [re.search(pattern, line) for pattern in (r'\b(?:mId|id)\s*=\s*(\d+)', r'\b(?:mSimSlotIndex|simSlotIndex)\s*=\s*(-?\d+)', r'\b(?:mMcc|mcc)\s*=\s*(\d{3})', r'\b(?:mMnc|mnc)\s*=\s*(\d{1,3})')]
        if all(values):
            identities.add(tuple(int(value[1]) for value in values))
    current = [row for row in identities if row[0] == sub_id and row[1] >= 0]
    if len(current) != 1 or current[0][2:] != (605, 1):
        return denied('orange_data_subscription_unproven')
    default = re.search(r'^Active default network: (\d+)\s*$', raw, re.M)
    if not default:
        return denied('default_network_unknown')
    default_id = int(default[1])
    agents = [line for line in raw.splitlines() if 'NetworkAgentInfo{' in line]
    if len(agents) > 1000:
        return denied('network_observation_limit')
    if any(re.search(r'Transports:\s*[A-Z_| ]*\bVPN\b', line) for line in agents):
        return denied('vpn_active')
    connected = []; orange = []; default_line = None
    for line in agents:
        net = re.search(r'network\{(\d+)\}', line)
        if not net:
            return denied('network_identity_unknown')
        if int(net[1]) == default_id:
            if default_line is not None:
                return denied('default_network_ambiguous')
            default_line = line
        if 'ni{MOBILE[' not in line or ' CONNECTED extra:' not in line:
            continue
        connected.append(int(net[1]))
        handle = re.search(r'handle\{(\d+)\}', line)
        telephony = re.search(r'(?:mSubId|subscriptionId)\s*=\s*(\d+)', line)
        ids = re.search(r'SubscriptionIds:\s*\{([\d, ]*)\}', line)
        exact_ids = [int(item.strip()) for item in ids[1].split(',') if item.strip()] if ids else []
        if ('CONNECTED extra: weborange}' in line and 'Transports: CELLULAR Capabilities:' in line
                and '&VALIDATED' in line and 'NOT_VPN' in line and 'INTERNET' in line
                and telephony and int(telephony[1]) == sub_id and exact_ids == [sub_id]
                and handle and 0 < int(handle[1]) < 2**63):
            orange.append((int(net[1]), int(handle[1])))
    if len(connected) != len(set(connected)) or len(connected) > 1:
        return denied('cellular_network_ambiguous')
    if default_line is None or 'NOT_VPN' not in default_line:
        return denied('default_network_unproven')
    if len(orange) == 1 and connected == [orange[0][0]]:
        if default_id == orange[0][0]:
            return {'route':'cellular_default','reason':'orange_cellular_default_validated','wifi_enabled':wifi}
        if wifi and 'ni{WIFI CONNECTED' in default_line and 'Transports: WIFI Capabilities:' in default_line and '&VALIDATED' in default_line:
            return {'route':'cellular_bound_wifi_unchanged','reason':'orange_cellular_available_wifi_default','wifi_enabled':wifi,
                    'selection':{'networkHandle':orange[0][1],'defaultDataSubscriptionId':sub_id}}
    # The old Wi-Fi-off corridor is allowed only for a proved Orange default SIM, no VPN or ambiguity.
    if wifi and 'ni{WIFI CONNECTED' in default_line and 'Transports: WIFI Capabilities:' in default_line:
        return {'route':'guarded_fallback','reason':'orange_cellular_not_ready','wifi_enabled':wifi}
    return denied('orange_cellular_not_qualified')


def capture_consultation_snapshot() -> dict:
    started = time.monotonic()
    state = settings_state(KEYS + AUTO_WIFI_KEYS + ('multi_sim_data_call',))
    wifi = wifi_enabled()
    raw = adb('shell','dumpsys','connectivity',timeout=8,check=True).stdout
    subscriptions = adb('shell','dumpsys','isub',timeout=6,check=True).stdout
    decision = parse_consultation_selection(raw, state['multi_sim_data_call']['value'], subscriptions, wifi)
    if proxy_active({key:state[key] for key in KEYS}):
        decision={'route':'blocked','reason':'external_proxy_active','wifi_enabled':wifi}
    return {'settings':{key:state[key] for key in KEYS},'auto_wifi':{key:state[key] for key in AUTO_WIFI_KEYS},
            'wifi_enabled':wifi,'decision':decision,'inspection_ms':round((time.monotonic()-started)*1000),
            'postcondition':{'defaultNetwork':parse_default_network(raw),
                'defaultNetworkId':int(re.search(r'^Active default network: (\d+)\s*$',raw,re.M)[1]) if re.search(r'^Active default network: (\d+)\s*$',raw,re.M) else None,
                'wifiEnabled':wifi,'wifiConnected':any('NetworkAgentInfo{' in line and 'ni{WIFI CONNECTED' in line for line in raw.splitlines()),
                'defaultDataSubscriptionId':state['multi_sim_data_call']['value']}}


def _blocked_consultation_context(reason: str = 'maxit_guard_required') -> dict:
    return {'schemaVersion':1,'verified':False,'state':'blocked','route':'blocked','remainingBudgetMs':0,'wifiToggled':False,'reason':reason}


def consultation_context(lease_id: str) -> dict:
    try:
        row, _fd = _consultation_inherited_fd(lease_id)
        decision = row['consultation_decision']
        remaining = int((float(row['consultation_deadline']) - CONSULTATION_RESTORE_RESERVE_S - time.monotonic()) * 1000)
        if remaining <= 0:
            return _blocked_consultation_context('consultation_budget_exhausted')
        if decision['route'] not in {'cellular_default','cellular_bound_wifi_unchanged','guarded_fallback'}:
            return _blocked_consultation_context('network_selection_unavailable')
        result = {'schemaVersion':1,'verified':True,'state':'admitted','route':decision['route'],
                  'remainingBudgetMs':min(44000,remaining),'wifiToggled':row.get('consultation_wifi_toggled') is True,'reason':decision['reason']}
        if decision['route'] == 'cellular_bound_wifi_unchanged':
            result['selection'] = decision['selection']
        return result
    except (RuntimeError, KeyError, TypeError, ValueError, OverflowError):
        return _blocked_consultation_context()


def _channel_app(op: str, session: str | None = None) -> dict:
    package = os.environ.get('SAMANTHA_APP_PACKAGE', 'ai.samantha.android.dev')
    if package not in {'ai.samantha.android', 'ai.samantha.android.dev'} or op not in {'status','close'}:
        raise RuntimeError('channel_app_identity_invalid')
    argv = ['shell','am','broadcast','-a','ai.samantha.android.CELLULAR_CHANNEL','-n',package+'/ai.samantha.android.CellularChannelReceiver','--es','op',op]
    if session is not None:
        if not re.fullmatch(r'[a-f0-9]{32}',session):
            raise RuntimeError('channel_app_identity_invalid')
        argv += ['--es','session',session]
    raw = adb(*argv,timeout=3,check=True).stdout
    if len(raw.encode()) > 16384:
        raise RuntimeError('channel_app_reply_invalid')
    match = re.search(r'Broadcast completed: result=-?\d+, data="(.*)"\s*$',raw.strip(),re.S)
    value = json.loads(match[1]) if match else None
    if not isinstance(value,dict) or value.get('schema') != 'samantha.cellular_channel.v1' or type(value.get('ok')) is not bool:
        raise RuntimeError('channel_app_reply_invalid')
    return value


def _consultation_forward(row: dict, forward_id: str, *, current_caller: bool) -> tuple[Path,dict]:
    if row.get('consultation_forward_lease_id') != forward_id:
        raise RuntimeError('channel_lease_mismatch')
    path = forward_lease_path(forward_id)
    forward = _forward_load(path)
    resource = forward['resource']
    socket_path = _cellular_socket_path(resource['local'])
    if (forward.get('consultation_lease_id') != row.get('lease_id') or forward.get('purpose') != 'orange-cellular-channel'
            or socket_path is None or CELLULAR_SOCKET_RE.fullmatch(socket_path.name)[1] != forward_id
            or resource['remote'] != CELLULAR_FORWARD_REMOTE_PREFIX+forward_id or resource['serial'] != ADB_ENDPOINT
            or forward.get('reused') is True or forward.get('ownership_lost') is True):
        raise RuntimeError('channel_forward_identity_invalid')
    if current_caller and (forward_owner_state(forward) != 'ALIVE'
                           or not _process_descends_from(os.getpid(),forward['owner_pid'])
                           or not _process_descends_from(forward['owner_pid'],row['owner_pid'])):
        raise RuntimeError('channel_forward_owner_invalid')
    return path,forward


def verify_consultation_channel(forward_id: str, session: str) -> dict:
    pointer = os.environ.get('SAMANTHA_MAXIT_LEASE_ID','')
    context = consultation_context(pointer)
    if context.get('verified') is not True or context.get('route') != 'cellular_bound_wifi_unchanged':
        return _blocked_consultation_context()
    try:
        if not re.fullmatch(r'[a-f0-9]{32}',session):
            raise RuntimeError('channel_app_identity_invalid')
        with mutation_lock(allow_consultation_delegate=True):
            row,_fd = _consultation_inherited_fd(pointer)
            path,forward = _consultation_forward(row,forward_id,current_caller=True)
            proof = _forward_inspect(path,forward)
            if (proof.get('ready') is not True or proof.get('created') is not True
                    or forward.get('ownership_proven') is not True):
                raise RuntimeError('channel_forward_unverified')
            app = _channel_app('status')
            selection = app.get('selection')
            expected = context['selection']
            if (app.get('ok') is not True or app.get('code') != 'open' or app.get('session') != session
                    or app.get('lease') != forward_id or app.get('socket') != 'ai.samantha.cellular.'+forward_id
                    or not isinstance(selection,dict) or type(selection.get('version')) is not int or selection.get('version') != 1
                    or type(selection.get('networkHandle')) is not int or selection['networkHandle'] != expected['networkHandle']
                    or type(selection.get('defaultDataSubscriptionId')) is not int or selection['defaultDataSubscriptionId'] != expected['defaultDataSubscriptionId']
                    or any(selection.get(key) is not True for key in ('validated','notVpn','uniqueCellular'))
                    or selection.get('source') != 'guard_owner_snapshot'):
                raise RuntimeError('channel_app_selection_unverified')
            previous = row.get('consultation_channel_session')
            if previous is not None and previous != session:
                raise RuntimeError('channel_session_conflict')
            row['consultation_channel_session'] = session
            write_json(forward_lease_path(pointer),row)
            return consultation_context(pointer)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError):
        return _blocked_consultation_context('channel_admission_unverified')


def cleanup_consultation_channel(lease: Path, row: dict) -> tuple[bool,dict]:
    """Certify app and forward independently; a foreign app never prevents owned-forward cleanup."""
    forward_id=row.get('consultation_forward_lease_id')
    if forward_id is None:
        return True,{}
    proof={'channel':'cellular_channel','forward_lease_id':forward_id,'channel_validated':False,'channel_closed':False}
    try:
        path,forward=_consultation_forward(row,forward_id,current_caller=False)
    except (OSError,ValueError,RuntimeError,KeyError,TypeError):
        return False,proof
    session=row.get('consultation_channel_session');app_closed=False;forward_closed=False
    try:
        app=_channel_app('status')
        if app.get('code') in {'open','cleanup_unknown','not_ready','closing'}:
            observed_session=app.get('session')
            if (app.get('lease')!=forward_id or app.get('socket')!='ai.samantha.cellular.'+forward_id
                    or not isinstance(observed_session,str) or not re.fullmatch(r'[a-f0-9]{32}',observed_session)
                    or session is not None and session!=observed_session):
                raise RuntimeError('foreign_channel_preserved')
            session=observed_session
            closed=_channel_app('close',session)
            if closed.get('ok') is not True or closed.get('code') not in {'closed','already_closed'}:
                raise RuntimeError('channel_app_cleanup_unverified')
            app=_channel_app('status')
        app_closed=app.get('ok') is True and app.get('code')=='idle' and app.get('session') is None
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError):
        pass
    try:
        released=_release_adb_forward(path,forward)
        forward_closed=(released.get('cleanup_verified') is True and released.get('restored_exact') is True
                        and _forward_observe(_forward_load(path))==[])
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError):
        pass
    proof.update(channel_closed=app_closed and forward_closed,channel_validated=row.get('consultation_channel_session') is not None)
    if isinstance(session,str) and re.fullmatch(r'[a-f0-9]{32}',session):
        proof['channel_session']=session
    return app_closed and forward_closed,proof


def prepare_consultation_cellular(lease_id: str) -> bool:
    """Restore the exact initial Wi-Fi-on state before the internal cellular bind."""
    if not verify_consultation_lease(lease_id):
        return False
    path = LEASES / (lease_id + ".json")
    try:
        row = json.loads(path.read_text())
        if row.get("consultation_decision") is not None or row.get("wifi_enabled") is not True:
            return False
        if wifi_enabled() is not True:
            set_wifi(True)
        if wifi_enabled() is not True:
            return False
        row["network_path"] = "cellular_bind_wifi_on"
        row["network_path_reason"] = "http_400_wifi"
        write_json(path, row)
        return True
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return False


def consultation_child_budget(deadline: float, now: float | None = None) -> float:
    """Time left to the child once the restoration reserve is kept; never zero, never past the total bound."""
    now = time.monotonic() if now is None else now
    return max(1.0, min(CONSULTATION_TOTAL_S - CONSULTATION_RESTORE_RESERVE_S, deadline - CONSULTATION_RESTORE_RESERVE_S - now))


def with_consultation_receipt(command: list[str], *, allow_cellular_channel: bool = True, keep_wifi: bool = False) -> int:
    # Serialize snapshot -> mutation -> child cleanup -> exact restore using the existing owner lock.
    # The total bound starts before the lock wait: a busy guard consumes the same 60 s.
    global _CONSULTATION_DEADLINE
    deadline = time.monotonic() + CONSULTATION_TOTAL_S
    previous_deadline=_CONSULTATION_DEADLINE
    _CONSULTATION_DEADLINE=deadline
    try:
        with mutation_lock() as lock_fd:
            return _with_consultation_receipt_locked(command, deadline,lock_fd,allow_cellular_channel=allow_cellular_channel,keep_wifi=keep_wifi)
    except RuntimeError as exc:
        if str(exc) != "network_mutation_guard_busy":
            raise
        print(json.dumps({"ok": False, "source": "maxit_network_guard", "state": "guard_busy"}))
        return 4
    finally:
        _CONSULTATION_DEADLINE=previous_deadline


def consultation_postcondition(row: dict, *, wait: bool = False) -> bool:
    """A Wi-Fi enabled bit does not prove an effective restored default route (S24 15/10)."""
    expected = row.get('consultation_postcondition')
    if not isinstance(expected,dict):
        return False
    end = min(time.monotonic() + (5.0 if wait else 0), float(row.get('consultation_deadline',time.monotonic())))
    while True:
        try:
            raw = adb('shell','dumpsys','connectivity',timeout=2,check=True).stdout
            if len(raw.encode()) > 1048576:
                return False
            default = parse_default_network(raw)
            network = re.search(r'^Active default network: (\d+)\s*$',raw,re.M)
            observed_settings=settings_state(KEYS+('multi_sim_data_call',))
            sub=observed_settings['multi_sim_data_call']['value']
            unchanged_settings=isinstance(row.get('settings'),dict) and all(observed_settings[key]==row['settings'].get(key) for key in KEYS)
            no_vpn=not any('NetworkAgentInfo{' in line and re.search(r'Transports:\s*[A-Z_| ]*\bVPN\b',line) for line in raw.splitlines())
            wifi = wifi_enabled()
            connected = any('NetworkAgentInfo{' in line and 'ni{WIFI CONNECTED' in line for line in raw.splitlines())
            same_identity = row.get('consultation_wifi_toggled') is True or bool(network and int(network[1])==expected.get('defaultNetworkId'))
            if (unchanged_settings and no_vpn and wifi is expected['wifiEnabled'] and connected is expected['wifiConnected']
                    and default == expected['defaultNetwork'] and sub == expected['defaultDataSubscriptionId'] and same_identity):
                return True
        except (OSError, RuntimeError, KeyError, TypeError, ValueError, subprocess.SubprocessError):
            pass
        if not wait or time.monotonic() >= end:
            return False
        time.sleep(min(.25,max(0,end-time.monotonic())))


def _with_consultation_receipt_locked(command: list[str], deadline: float | None = None, lock_fd: int | None = None, *, allow_cellular_channel: bool = True, keep_wifi: bool = False) -> int:
    """Consultation-only admission/cleanup; generic and payment with-wifi-off stay untouched."""
    deadline = time.monotonic()+CONSULTATION_TOTAL_S if deadline is None else deadline
    if len(command)<4 or command[:3] != [sys.executable,'-m','telecom.maxit_guarded_service']:
        raise ValueError('invalid_consultation_command')
    identity = process_identity(os.getpid())
    if identity is None or not canonical_consultation_owner(os.getpid()) or lock_fd is None or not _guard_fd_is_locked(lock_fd,os.getpid()):
        print(json.dumps({'ok':False,'source':'maxit_network_guard','state':'guard_unavailable'}))
        return 4
    try:
        snapshot = capture_consultation_snapshot()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'ok':False,'source':'maxit_network_guard','state':'network_snapshot_unavailable'}))
        return 4
    decision = snapshot['decision']
    if not allow_cellular_channel and decision['route']=='cellular_bound_wifi_unchanged':
        decision={'route':'guarded_fallback','reason':'channel_disabled_for_canonical_consultation','wifi_enabled':snapshot['wifi_enabled']}
    if keep_wifi and decision['route']=='guarded_fallback':
        # Incident 15/10 : couper le Wi-Fi pendant un appel vocal coupe la session vocale (réponse jamais dite,
        # chargement infini). Décision du 17/10 « 4G et Wi-Fi » : sans chemin cellulaire attesté, on le dit, sans mutation.
        print(json.dumps({'ok':False,'source':'maxit_network_guard','state':'orange_cellular_required_wifi_kept',
                          'reason':decision.get('reason'),
                          'network_guard':{'path':'blocked','wifi_initial':snapshot['wifi_enabled'],'wifi_disabled':False,
                                           'dns_ready_ms':None,'restored':True,'lease_id':None}}))
        return 4
    if decision['route']=='blocked':
        print(json.dumps({'ok':False,'source':'maxit_network_guard','state':decision['reason'],
                          'network_guard':{'path':'blocked','wifi_initial':snapshot['wifi_enabled'],'wifi_disabled':False,
                                           'dns_ready_ms':None,'restored':False,'lease_id':None}}))
        return 4
    lease = create_lease('maxit-deterministic',lease_type='wifi_off',include_wifi=True,
                         ttl_s=int(CONSULTATION_TOTAL_S),snapshot=snapshot)
    row = json.loads(lease.read_text())
    row.update(owner_identity=identity,consultation_decision=decision,consultation_deadline=deadline,
               consultation_postcondition=snapshot['postcondition'],consultation_wifi_toggled=False)
    write_json(lease,row)
    proof = {'wifi_initial':row['wifi_enabled'],'wifi_disabled':False,'dns_ready_ms':None,
             'restored':False,'lease_id':lease.stem,'path':decision['route']}
    payload = {'ok':False,'source':'maxit_network_guard','state':'guard_unavailable'}
    code=4; child_cleanup_verified=True; channel_cleanup_verified=True
    def interrupted(_sig,_frame):
        raise KeyboardInterrupt
    previous = {sig:signal.signal(sig,interrupted) for sig in (signal.SIGTERM,signal.SIGINT)}
    try:
        if not spawn_restorer(lease,row['owner_token']):
            raise RuntimeError('consultation_restorer_unavailable')
        if decision['route']=='guarded_fallback':
            # Same authorized Wi-Fi-off consultation corridor; never mutate on the qualified fast paths.
            row['consultation_wifi_toggled']=True
            write_json(lease,row)
            set_wifi(False)
            proof['wifi_disabled']=True
        if time.monotonic() >= deadline-CONSULTATION_RESTORE_RESERVE_S:
            raise RuntimeError('consultation_budget_exhausted')
        env=os.environ.copy()
        env['SAMANTHA_MAXIT_LEASE_ID']=lease.stem
        env['SAMANTHA_MAXIT_GUARD_LOCK_FD']=str(lock_fd)
        env.pop('SAMANTHA_MAXIT_CHANNEL',None)
        child_cleanup_verified=False
        child=collect_consultation_child(command,env,timeout_s=consultation_child_budget(deadline))
        child_cleanup_verified=True
        value=json.loads(child.stdout or '')
        if not isinstance(value,dict):
            raise ValueError('consultation_output_invalid')
        # Never accept network_guard or restoration assertions from child/provider JSON.
        value.pop('network_guard',None); value.pop('network_path',None)
        payload=value; code=child.returncode if value.get('ok') is True else 4
        if child.returncode != 0 and value.get('ok') is True:
            payload={'ok':False,'source':'maxit_network_guard','state':'child_result_contradictory'};code=4
        milliseconds=payload.pop('dns_ready_ms',None)
        if type(milliseconds) is int and 0<=milliseconds<=8000:
            proof['dns_ready_ms']=milliseconds
    except ConsultationChildFailure as exc:
        child_cleanup_verified=exc.cleanup_verified
        payload={'ok':False,'source':'maxit_network_guard','state':str(exc)};code=4
    except RuntimeError as exc:
        known=str(exc) if str(exc) in {'consultation_restorer_unavailable','consultation_budget_exhausted'} else 'guard_unavailable'
        payload={'ok':False,'source':'maxit_network_guard','state':known};code=4
    except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
        payload={'ok':False,'source':'maxit_network_guard','state':'guard_unavailable'};code=4
    finally:
        # Do not let a second ordinary signal interrupt cleanup or label late effects as restored.
        for sig in previous:
            signal.signal(sig,signal.SIG_IGN)
        try:
            row=json.loads(lease.read_text())
            if child_cleanup_verified:
                channel_cleanup_verified,channel_proof=cleanup_consultation_channel(lease,row)
                proof.update(channel_proof)
            else:
                channel_cleanup_verified=False
            restored=False
            if child_cleanup_verified and channel_cleanup_verified:
                restore_lease(row)
                restored=True  # consultation-aware restore_lease proves effective default route + SIM too.
            proof['restored']=restored
            if restored:
                lease.unlink(missing_ok=True)
                write_receipt('healthy','consultation_network_restored',network_guard=proof)
            else:
                payload={'ok':False,'source':'maxit_network_guard','state':'child_cleanup_unverified' if not child_cleanup_verified else 'channel_cleanup_unverified'};code=4
                write_receipt('degraded','consultation_cleanup_unverified',network_guard=proof)
            if decision['route']=='cellular_bound_wifi_unchanged':
                paths=payload.get('network_channel')
                if isinstance(paths,dict) and paths.get('auth')=='cellular_channel' and paths.get('read')=='cellular_channel':
                    proof.update(auth_path='cellular_channel',read_path='cellular_channel')
                elif payload.get('ok') is True:
                    payload={'ok':False,'source':'maxit_network_guard','state':'channel_transport_unverified'};code=4
        except (OSError,RuntimeError,ValueError,KeyError,TypeError,subprocess.SubprocessError):
            payload={'ok':False,'source':'maxit_network_guard','state':'network_postcondition_unverified'};code=4
            proof['restored']=False
            write_receipt('degraded','consultation_network_restore_unverified',network_guard=proof)
        finally:
            for sig,handler in previous.items():
                signal.signal(sig,handler)
    payload.pop('channel_cleanup',None)
    payload['network_guard']=proof;payload['network_path']=proof['path']
    payload['network_metrics']={'network_inspection_ms':snapshot['inspection_ms'],'wifi_toggled':proof['wifi_disabled']}
    print(json.dumps(payload))
    return code

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
    immutable = {key:row.get(key) for key in ("type","lease_id","owner_pid","owner_identity","owner_token","purpose","created_at")}
    for _ in range(max(1, attempts)):
        try:
            # The owner may have fsynced child identity after our previous read and died immediately.
            if isinstance(row.get("consultation_decision"),dict):
                current = read_wifi_lease(lease,token)
                if current is None:
                    return "lease_released"
                if any(current.get(key)!=value for key,value in immutable.items()):
                    raise RuntimeError("consultation_lease_identity_changed")
                row=current
            if isinstance(row.get("consultation_decision"),dict) and not stop_orphan_consultation_child(row):
                raise RuntimeError("consultation_orphan_cleanup_unverified")
            with mutation_lock(RESTORE_LOCK_TIMEOUT_S):
                row = read_wifi_lease(lease, token)
                if row is None:
                    return "lease_released"
                cause = "ttl_expired" if lease_expired(row, clock()) else "owner_dead"
                if isinstance(row.get("consultation_decision"),dict):
                    cleaned,_proof=cleanup_consultation_channel(lease,row)
                    if not cleaned:
                        raise RuntimeError("consultation_channel_cleanup_unverified")
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
    prepare = sub.add_parser("prepare-consultation-cellular")
    prepare.add_argument("lease_id")
    verify = sub.add_parser("verify-consultation-lease")
    verify.add_argument("lease_id")
    context = sub.add_parser("consultation-context")
    context.add_argument("lease_id")
    channel_verify = sub.add_parser("verify-consultation-channel")
    channel_verify.add_argument("lease_id")
    channel_verify.add_argument("--session", required=True)
    consult = sub.add_parser("with-consultation-receipt")
    consult.add_argument("--no-cellular-channel",action="store_true")
    consult.add_argument("--keep-wifi",action="store_true",help="never toggle Wi-Fi (live voice): refuse the Wi-Fi-off corridor with its reason")
    consult.add_argument("command", nargs="+")
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
    if args.cmd in {"consultation-context", "verify-consultation-channel"}:
        result = consultation_context(args.lease_id) if args.cmd == "consultation-context" else verify_consultation_channel(args.lease_id,args.session)
        print(json.dumps(result))
        return 0 if result.get("verified") is True else 4
    if args.cmd == "prepare-consultation-cellular":
        valid = prepare_consultation_cellular(args.lease_id)
        print(json.dumps({"success": valid, **({"lease_id": args.lease_id, "path": "cellular_bind_wifi_on"} if valid else {"reason": "maxit_guard_required"})}))
        return 0 if valid else 4
    if args.cmd == "verify-consultation-lease":
        valid = verify_consultation_lease(args.lease_id)
        print(json.dumps({"success": valid, **({"lease_id": args.lease_id} if valid else {"reason": "maxit_guard_required"})}))
        return 0 if valid else 4
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
    if args.cmd == "with-consultation-receipt":
        return with_consultation_receipt(command,allow_cellular_channel=not args.no_cellular_channel,keep_wifi=args.keep_wifi)
    if args.cmd == "with-wifi-off":
        return with_wifi_off(args.purpose, command)
    return with_global_proxy(args.endpoint, args.purpose, command)

if __name__ == "__main__":
    raise SystemExit(main())
