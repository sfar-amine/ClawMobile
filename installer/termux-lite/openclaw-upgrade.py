#!/usr/bin/env python3
"""OpenClaw runtime upgrade 2026.9.6 -> 2026.10.9 on the S24, with automatic rollback.

One run, one receipt (`<receipts>/openclaw-upgrade-<stamp>.json`), under the SAME lock as companion-deploy.sh
(`deploys/companion-deploy.lock`): while it is held the health manager skips every repair and the Companion
refuses `/v1/runtime/restart`, so nothing restarts the Gateway behind this script. Phases:

  preflight  load, memory, free disk >= 3x the databases, no heavy job, lock, versions, prerequisites
  stage      candidate OpenClaw and Node copied next to the live trees (Gateway still serving)
  stop       Gateway stopped by the PID that owns its port; core-services-watchdog paused (SIGSTOP)
  backup     every SQLite database through the SQLite backup API (WAL-aware), openclaw.json, credentials,
             agent JSON files; PRAGMA integrity_check on every copy
  switch     live trees renamed aside (rollback copies, same filesystem), candidates renamed in
  doctor     `openclaw doctor --fix --non-interactive` with the Gateway stopped
  consent    `plugins enable <Samantha plugin> --accept-capabilities` (2026.10.9 registers no tool before it)
  whatsapp   @openclaw/whatsapp at the target version: prepared with npm in a copy of its project during
             `stage` (OpenClaw's own installer refuses on Android), renamed in; the old tree parked
  start      Gateway (and the Companion in prod) started; gates: HTTP health, health JSON, Samantha plugin
             loaded with its tools, one real agent turn, WhatsApp connected, no automatic triage process
  receipt    `deployed`, or on any failure after `stop`: automatic restore of databases, config,
             credentials, OpenClaw and Node trees, WhatsApp generation, restart, health + turn, `rolled_back`

The receipt and the log carry no secret: no config content, no environment value, no raw CLI output (health
JSON contains phone numbers), only parsed booleans, counts, versions, sizes and durations.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RECEIPT_VERSION = 1
SOURCE_VERSION = "2026.9.6"
TARGET_VERSION = "2026.10.9"
TARGET_NODE = "24.22.2"
COMPAT_SETS = ("agent-exec-auth-scope", "native-turn-provenance", "model-flow-selection", "gateway-prep-stages",
               "memory-retrieval-warm", "android-fs-compat")
HEAVY_JOBS = r"companion-deploy\.sh|activate-ui-playbooks\.sh|voice_bench|GradleDaemon|gradle-termux|tsc -p tsconfig"
GATES = ("health_http", "health_json", "plugin_tools", "agent_turn", "whatsapp", "companion", "no_triage")
STAMP_RE = re.compile(r"^\d{8}T\d{6}$")
SECRETISH = re.compile(r"(?i)((?:token|secret|password|passwd|apikey|api_key|authorization|bearer)[\"'=:\s]+)\S+")
LONG_OPAQUE = re.compile(r"[A-Za-z0-9_\-+/=]{32,}")
PHONE = re.compile(r"\+?\d[\d ]{8,}\d")


class Refused(Exception):
    """Preflight refusal: nothing was stopped or changed."""


class Failed(Exception):
    """A phase or gate failed after the Gateway was stopped: rollback follows."""


def redact(text: str) -> str:
    text = SECRETISH.sub(lambda m: m.group(1) + "<redacted>", text)
    text = LONG_OPAQUE.sub("<redacted>", text)
    return PHONE.sub("<number>", text)


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------------------------- layout
def expand(value, env):
    if isinstance(value, str):
        value = value.replace("$PREFIX", env.get("PREFIX", "/data/data/com.termux/files/usr"))
        value = value.replace("$HOME", env["HOME"])
        return os.path.expanduser(value) if value.startswith("~") else value
    if isinstance(value, list):
        return [expand(v, env) for v in value]
    if isinstance(value, dict):
        return {k: expand(v, env) for k, v in value.items()}
    return value


def default_layout(profile: str, env: dict) -> dict:
    """Prod and preprod differ only by paths, port, env and the WhatsApp gate."""
    common = {
        "source_version": SOURCE_VERSION, "target_version": TARGET_VERSION, "target_node": TARGET_NODE,
        "plugin_id": "openclaw-plugin-mobile-ui", "min_tools": 42, "consent_plugins": ["openclaw-plugin-mobile-ui"],
        "health_paths": ["/health"],
        "turn": {"agent": "main", "timeout_s": 180,
                 "message": "Vérification technique de montée de version : réponds seulement « prêt »."},
        "budgets": {"stop_s": 30, "health_s": 300, "doctor_s": 1200, "whatsapp_install_s": 900,
                    "whatsapp_connect_s": 180, "cli_s": 150, "companion_s": 300},
        "max_load": 7.0, "min_available_mb": 1200, "disk_factor": 3, "lock_wait_s": 10,
        "keep_backups": 2, "compat_required": list(COMPAT_SETS), "rollback_node": "restore",
        "whatsapp": {"spec": "@openclaw/whatsapp@" + TARGET_VERSION, "mode": "npm"},
        "meminfo": "/proc/meminfo", "heavy_jobs": HEAVY_JOBS,
    }
    if profile == "prod":
        release = "$HOME/.openclaw/releases/current/termux-lite"
        layout = {
            "profile": "prod", "port": 18789,
            "state_dir": "$HOME/.openclaw", "config": "$HOME/.openclaw/openclaw.json",
            "openclaw_root": "$PREFIX/lib/node_modules/openclaw", "node_dir": "$HOME/.openclaw-android/node",
            "candidate_openclaw": "$HOME/.openclaw-android/staging/oc-global/lib/node_modules/openclaw",
            "candidate_node": "$HOME/.openclaw-android/staging/node-24.22.2",
            "cli": ["$PREFIX/bin/openclaw"], "npm": ["$HOME/.openclaw-android/bin/npm"],
            "start": [release + "/gateway-start.sh"],
            "gateway_start_script": release + "/gateway-start.sh",
            "gateway_log": "$HOME/.openclaw/logs/companion-openclaw-gateway.log",
            "compat_dir": "$HOME/ClawMobile/installer/termux-lite/openclaw-compat",
            "receipts": "$HOME/.openclaw/deploys", "backups": "$HOME/.openclaw/backups/openclaw-upgrade",
            "lock": "$HOME/.openclaw/deploys/companion-deploy.lock", "foreign_locks": [],
            "pause_patterns": [r"core-services-watchdog\.sh"],
            "gateway_pattern": r"(^|/)openclaw-gateway(\s|$)",
            "lease_preflight": ["python3", release + "/gateway-preflight.py", "agent-leases", "--state-dir",
                                "$HOME/.openclaw", "--apply"],
            "companion": {"url": "http://127.0.0.1:8765", "pattern": "dist/companion/server.js",
                          "start": [release + "/companion-server.sh"]},
            "whatsapp_gate": True, "triage_stub_log": None,
            "notify": [release + "/incident-notify.sh", "human_required"],
            "env": {},
        }
    elif profile == "staging":
        r = "$HOME/.openclaw-android/staging/upgrade-rehearsal"
        layout = {
            "profile": "staging", "port": 19789,
            "state_dir": r + "/state", "config": r + "/state/openclaw.json",
            "openclaw_root": r + "/live/openclaw", "node_dir": r + "/live/node",
            "candidate_openclaw": "$HOME/.openclaw-android/staging/oc-global/lib/node_modules/openclaw",
            "candidate_node": "$HOME/.openclaw-android/staging/node-24.22.2",
            "cli": [r + "/live/bin/openclaw"], "npm": [r + "/live/bin/npm"],
            "start": [r + "/live/bin/openclaw", "gateway", "--bind", "loopback", "--port", "19789", "--verbose"],
            "gateway_start_script": None,
            "gateway_log": r + "/logs/gateway.log",
            "compat_dir": "$HOME/ClawMobile/installer/termux-lite/openclaw-compat",
            "receipts": r + "/deploys", "backups": r + "/backups",
            "lock": r + "/deploys/companion-deploy.lock",
            "foreign_locks": ["$HOME/.openclaw/deploys/companion-deploy.lock"],
            "pause_patterns": [], "companion": None, "gateway_pattern": None,
            # Isolation: no WhatsApp credentials copied and channels skipped; the real account never connects twice.
            "whatsapp_gate": False, "triage_stub_log": r + "/logs/triage-stub.log", "notify": None,
            "compat_apply_on_start": True,
            "nice": 10,
            "env": {
                "HOME": r + "/home", "OPENCLAW_HOME": r + "/home", "OPENCLAW_STATE_DIR": r + "/state",
                "OPENCLAW_CONFIG_PATH": r + "/state/openclaw.json", "OPENCLAW_GATEWAY_PORT": "19789",
                "OPENCLAW_SKIP_CHANNELS": "1", "OPENCLAW_SKIP_CRON": "1", "OPENCLAW_SKIP_GMAIL_WATCHER": "1",
                "OPENCLAW_DISABLE_BONJOUR": "1", "OPENCLAW_NO_AUTO_UPDATE": "1",
                "OPENCLAW_NO_RESPAWN": "1", "TMPDIR": r + "/tmp", "LANG": "C.UTF-8",
                # Keeps the candidate invisible to prod `pgrep -f openclaw-gateway` watchdogs.
                "NODE_OPTIONS": "-r $HOME/.openclaw-android/staging/patches/title-guard.js",
                # claude/codex stubs first on PATH: an automatic triage attempt is blocked and logged.
                "PATH": r + "/live/bin:" + r + "/live/node/bin:$PREFIX/bin",
                "@unset": ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_URL",
                           "CLAWMOBILE_GATEWAY_PORT", "SAMANTHA_DEPLOY_LOCK_FD"],
            },
        }
    else:
        raise ValueError("unknown_profile")
    return {**common, **layout}


def load_layout(profile: str, override: str | None, env: dict) -> dict:
    layout = default_layout(profile, env)
    if override:
        extra = json.loads(Path(override).read_text())
        for key, value in extra.items():
            if isinstance(value, dict) and isinstance(layout.get(key), dict) and key != "env":
                layout[key] = {**layout[key], **value}
            else:
                layout[key] = value
    return expand(layout, env)


# --------------------------------------------------------------------------------------------- host facts
def openclaw_version(root: Path) -> str | None:
    try:
        meta = json.loads((Path(root) / "package.json").read_text())
        return meta.get("version") if meta.get("name") == "openclaw" else None
    except (OSError, ValueError):
        return None


def node_version(node_dir: Path) -> str | None:
    try:
        text = (Path(node_dir) / "include/node/node_version.h").read_text()
        parts = [re.search(rf"#define NODE_{name}_VERSION (\d+)", text).group(1) for name in ("MAJOR", "MINOR", "PATCH")]
        return ".".join(parts)
    except (OSError, AttributeError):
        return None


def package_version(path: Path) -> str | None:
    try:
        return json.loads(Path(path).read_text()).get("version")
    except (OSError, ValueError):
        return None


def load1() -> float:
    try:
        out = subprocess.run(["uptime"], capture_output=True, text=True, timeout=5).stdout
        match = re.search(r"load average:\s*([0-9.]+)", out)
        if match:
            return float(match.group(1))
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        return os.getloadavg()[0]
    except OSError:
        return 0.0


def available_mb(meminfo: str) -> int:
    try:
        for line in Path(meminfo).read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def free_bytes(path: Path) -> int:
    path = Path(path)
    while not path.exists():
        path = path.parent
    info = os.statvfs(path)
    return info.f_bavail * info.f_frsize


def proc_cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        return ""


def proc_stat(pid: int) -> tuple[int, int] | None:
    """(ppid, start time in clock ticks since boot)."""
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        rest = text[text.rindex(")") + 2:].split()
        return int(rest[1]), int(rest[19])
    except (OSError, ValueError, IndexError):
        return None


def all_pids() -> list[int]:
    return [int(name) for name in os.listdir("/proc") if name.isdigit()]


def own_lineage() -> set[int]:
    pids, pid = set(), os.getpid()
    while pid > 1 and pid not in pids:
        pids.add(pid)
        st = proc_stat(pid)
        if not st:
            break
        pid = st[0]
    return pids


def find_pids(pattern: str) -> list[int]:
    regex, mine = re.compile(pattern), own_lineage()
    return sorted(pid for pid in all_pids() if pid not in mine and regex.search(proc_cmdline(pid)))


def listening_pids(port: int) -> list[int]:
    """PIDs owning a LISTEN socket on 127.0.0.1/::1/any:<port> (kill by port, never by name)."""
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            cols = line.split()
            if len(cols) > 9 and cols[3] == "0A" and int(cols[1].rsplit(":", 1)[1], 16) == port:
                inodes.add(cols[9])
    found = set()
    if not inodes:
        return []
    for pid in all_pids():
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                try:
                    link = os.readlink(f"/proc/{pid}/fd/{fd}")
                except OSError:
                    continue
                if link.startswith("socket:[") and link[8:-1] in inodes:
                    found.add(pid)
                    break
        except OSError:
            continue
    return sorted(found)


def port_open(port: int, timeout: float = 0.5) -> bool:
    import socket
    with contextlib.suppress(OSError):
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    return False


def proc_env(pid: int) -> dict:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return {}
    out = {}
    for item in raw:
        key, sep, value = item.partition(b"=")
        if sep:
            out[key.decode(errors="replace")] = value.decode(errors="replace")
    return out


def lease_gateway_pid(state_dir: Path) -> int | None:
    """OpenClaw's own record of the Gateway owner (state_leases/gateway-owner), read-only."""
    db = Path(state_dir) / "state/openclaw.sqlite"
    if not db.is_file():
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        try:
            row = con.execute("select payload_json from state_leases where scope='gateway-owner'").fetchone()
        finally:
            con.close()
        pid = int(json.loads(row[0])["owner"]["pid"]) if row else None
        return pid if pid and Path(f"/proc/{pid}").exists() else None
    except (sqlite3.Error, ValueError, KeyError, TypeError):
        return None


def descendants(roots: set[int]) -> set[int]:
    parent = {}
    for pid in all_pids():
        st = proc_stat(pid)
        if st:
            parent[pid] = st[0]
    out, changed = set(roots), True
    while changed:
        changed = False
        for pid, ppid in parent.items():
            if ppid in out and pid not in out:
                out.add(pid)
                changed = True
    return out - set(roots)


def kill_pids(pids, timeout_s: float) -> dict:
    """SIGTERM precise PIDs, wait, SIGKILL the survivors. Never by pattern."""
    pids = [p for p in pids if p > 1 and p != os.getpid()]
    for pid in pids:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline and any(Path(f"/proc/{p}").exists() for p in pids):
        time.sleep(0.25)
    killed = []
    for pid in pids:
        if Path(f"/proc/{pid}").exists():
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
                killed.append(pid)
    time.sleep(0.5 if killed else 0)
    return {"terminated": len(pids), "killed": len(killed)}


def http_status(url: str, timeout: float = 5) -> int:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, ValueError):
        return 0


# --------------------------------------------------------------------------------------------- SQLite
def inventory(state_dir: Path) -> list[Path]:
    """Every OpenClaw SQLite database doctor can touch (main state, agents, headless states)."""
    state_dir = Path(state_dir)
    found = []
    for pattern in ("state/*.sqlite", "agents/*/agent/*.sqlite", "headless-state*/state/*.sqlite"):
        for path in sorted(state_dir.glob(pattern)):
            if path.is_file() and not path.is_symlink():
                found.append(path)
    return found


def db_bytes(path: Path) -> int:
    total = 0
    for suffix in ("", "-wal", "-shm"):
        with contextlib.suppress(OSError):
            total += Path(str(path) + suffix).stat().st_size
    return total


def sqlite_backup(src: Path, dst: Path) -> None:
    """Consistent copy through the SQLite backup API (reads the WAL); never a bare file copy."""
    dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    partial = dst.with_name(dst.name + ".partial")
    partial.unlink(missing_ok=True)
    try:
        source = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=30)
        source.execute("select count(*) from sqlite_master").fetchone()
    except sqlite3.Error:
        source = sqlite3.connect(str(src), timeout=30)
    try:
        target = sqlite3.connect(str(partial))
        try:
            source.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
        finally:
            target.close()
    finally:
        source.close()
    os.chmod(partial, 0o600)
    with open(partial, "rb") as handle:
        os.fsync(handle.fileno())
    os.replace(partial, dst)


def integrity(path: Path) -> bool:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    try:
        return con.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    finally:
        con.close()


def schema_versions(path: Path) -> dict:
    out = {}
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        try:
            out["user_version"] = con.execute("PRAGMA user_version").fetchone()[0]
            if con.execute("select 1 from sqlite_master where type='table' and name='schema_meta'").fetchone():
                rows = con.execute("select * from schema_meta").fetchall()
                out["schema_meta"] = {str(r[0]): r[2] for r in rows if len(r) > 2 and isinstance(r[2], int)}
        finally:
            con.close()
    except sqlite3.Error as error:
        out["error"] = type(error).__name__
    return out


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def restore_db(backup: Path, live: Path) -> None:
    """Atomic restore: the backup copy (single file, no WAL) replaces the database; stale WAL/SHM removed first."""
    partial = live.with_name(live.name + ".upgrade-restore")
    shutil.copyfile(backup, partial)
    os.chmod(partial, 0o600)
    with open(partial, "rb") as handle:
        os.fsync(handle.fileno())
    for suffix in ("-wal", "-shm"):
        Path(str(live) + suffix).unlink(missing_ok=True)
    os.replace(partial, live)


def copy_atomic(src: Path, dst: Path) -> None:
    partial = dst.with_name(dst.name + ".upgrade-restore")
    shutil.copy2(src, partial)
    os.replace(partial, dst)


# --------------------------------------------------------------------------------------------- the run
class Upgrade:
    def __init__(self, layout: dict, options: argparse.Namespace):
        self.l, self.o = layout, options
        self.stamp = options.stamp or time.strftime("%Y%m%dT%H%M%S")
        if not STAMP_RE.match(self.stamp):
            raise ValueError("invalid_stamp")
        self.receipts = Path(layout["receipts"])
        self.receipts.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.receipt_path = self.receipts / f"openclaw-upgrade-{self.stamp}.json"
        self.log_path = self.receipts / f"openclaw-upgrade-{self.stamp}.log"
        self.backup = Path(layout["backups"]) / f"openclaw-upgrade-{self.stamp}"
        self.state = Path(layout["state_dir"])
        self.oc_live, self.node_live = Path(layout["openclaw_root"]), Path(layout["node_dir"])
        self.oc_cand = self.oc_live.with_name(self.oc_live.name + ".upgrade-candidate")
        self.node_cand = self.node_live.with_name(self.node_live.name + ".upgrade-candidate")
        self.oc_keep = self.oc_live.with_name(f"{self.oc_live.name}.rollback-{layout['source_version']}-{self.stamp}")
        self.node_keep = self.node_live.with_name(f"{self.node_live.name}.rollback-{self.stamp}")
        self.doc = {"version": RECEIPT_VERSION, "kind": "openclaw-upgrade", "state": "in_progress",
                    "profile": layout["profile"], "stamp": self.stamp, "phases": {}, "gates": {},
                    "options": {"force_gate_failure": options.force_gate_failure, "dry_run": options.dry_run}}
        self.lock_fd = None
        self.paused: list[int] = []
        self.window_start_ticks = None
        self.down_at = None
        self.done = {"stopped": False, "backed_up": False, "switched_openclaw": False, "switched_node": False,
                     "doctor": False, "whatsapp_parked": [], "companion_restarted": False, "companion_stopped": False}
        self.dbs: list[dict] = []
        self.gateway_pid = None
        self.gateway_child = None
        self.wa_candidate = None

    # ----------------------------------------------------------------- plumbing
    def log(self, event: str, **fields) -> None:
        line = json.dumps({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                           "event": event, **fields}, ensure_ascii=False)
        fd = os.open(self.log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as out:
            out.write(redact(line) + "\n")

    def write_receipt(self) -> None:
        self.doc["at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        partial = self.receipt_path.with_name(self.receipt_path.name + ".partial")
        fd = os.open(partial, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(self.doc, out, ensure_ascii=False, indent=1)
            out.flush()
            os.fsync(out.fileno())
        os.replace(partial, self.receipt_path)

    @contextlib.contextmanager
    def phase(self, name: str):
        started = time.monotonic()
        self.log("phase_start", phase=name)
        entry = {"ok": False}
        self.doc["phases"][name] = entry
        try:
            yield entry
            entry["ok"] = True
        finally:
            entry["ms"] = int((time.monotonic() - started) * 1000)
            self.log("phase_end", phase=name, ok=entry["ok"], ms=entry["ms"])
            self.write_receipt()

    def env(self, extra: dict | None = None) -> dict:
        env = dict(os.environ)
        spec = dict(self.l.get("env") or {})
        for key in spec.pop("@unset", []):
            env.pop(key, None)
        env.update({k: str(v) for k, v in spec.items()})
        env.pop("SAMANTHA_DEPLOY_LOCK_FD", None)
        env["OPENCLAW_UPGRADE_STAMP"] = self.stamp
        env.update(extra or {})
        return env

    def cli(self, args: list[str], timeout_s: float, extra_env: dict | None = None, log_name: str | None = None):
        cmd = list(self.l["cli"]) + args
        if self.l.get("nice"):
            cmd = ["nice", "-n", str(self.l["nice"])] + cmd
        started = time.monotonic()
        try:
            run = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s, env=self.env(extra_env),
                                 stdin=subprocess.DEVNULL)
            rc, out, err = run.returncode, run.stdout, run.stderr
        except subprocess.TimeoutExpired as error:
            rc = 124
            out = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
            err = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
        ms = int((time.monotonic() - started) * 1000)
        if log_name:
            path = self.receipts / f"openclaw-upgrade-{self.stamp}-{log_name}.log"
            fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(redact(out[-200000:]) + "\n--- stderr ---\n" + redact(err[-200000:]))
            self.doc.setdefault("logs", {})[log_name] = str(path)
        return rc, out, err, ms

    def cli_json(self, args, timeout_s, log_name=None):
        rc, out, err, ms = self.cli(args, timeout_s, log_name=log_name)
        for text in (out, err):
            start = text.find("{")
            if start >= 0:
                try:
                    return rc, json.loads(text[start:]), ms
                except ValueError:
                    continue
        return rc, None, ms

    # ----------------------------------------------------------------- preflight
    def acquire_lock(self) -> None:
        lock = Path(self.l["lock"])
        lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            os.close(fd)
            raise Refused("deploy_lock_invalid")
        deadline = time.monotonic() + max(0, min(600, int(self.l["lock_wait_s"])))
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise Refused("deploy_already_running: deploy_lock_busy")
                time.sleep(0.2)
        self.lock_fd = fd
        for other in self.l.get("foreign_locks") or []:
            path = Path(other)
            if not path.exists():
                continue
            probe = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(probe, fcntl.LOCK_UN)
            except BlockingIOError:
                raise Refused("foreign_deploy_running: " + path.name)
            finally:
                os.close(probe)

    def compat_check(self, root: Path) -> dict:
        owner = Path(self.l["compat_dir"]) / "whatsapp-network-recovery.py"
        results = {}
        if not owner.is_file():
            return {"_owner": "absent"}
        for name in COMPAT_SETS:
            if not owner.with_name(name + ".json").is_file():
                results[name] = "manifest_absent"
                continue
            try:
                run = subprocess.run([sys.executable, str(owner), "--patch-set", name, "--check",
                                      "--openclaw-root", str(root)], capture_output=True, text=True, timeout=60)
                doc = json.loads(run.stdout.strip().splitlines()[-1])
                results[name] = doc.get("state") if doc.get("ok") or doc.get("state") == "drift" else \
                    "refused:" + str(doc.get("reason", "unknown"))
            except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                results[name] = "refused:check_failed"
        return results

    def preflight(self) -> None:
        with self.phase("preflight") as p:
            self.acquire_lock()
            heavy = find_pids(self.l.get("heavy_jobs") or HEAVY_JOBS)
            p["heavy_jobs"] = len(heavy)
            if heavy:
                raise Refused("heavy_job_running")
            p["load1"], p["available_mb"] = load1(), available_mb(self.l["meminfo"])
            if p["load1"] > float(self.l["max_load"]):
                raise Refused(f"load_too_high: {p['load1']}")
            if p["available_mb"] < int(self.l["min_available_mb"]):
                raise Refused(f"memory_low: {p['available_mb']}MB")
            current, candidate = openclaw_version(self.oc_live), openclaw_version(Path(self.l["candidate_openclaw"]))
            self.doc["from"] = {"openclaw": current, "node": node_version(self.node_live)}
            self.doc["to"] = {"openclaw": candidate, "node": node_version(Path(self.l["candidate_node"]))}
            if current != self.l["source_version"]:
                raise Refused(f"unexpected_current_version: {current}")
            if candidate != self.l["target_version"]:
                raise Refused(f"unexpected_candidate_version: {candidate}")
            if self.doc["to"]["node"] != self.l["target_node"]:
                raise Refused(f"unexpected_candidate_node: {self.doc['to']['node']}")
            for path in (self.oc_keep, self.node_keep):
                if path.exists():
                    raise Refused("rollback_path_exists")
            dbs = inventory(self.state)
            if not dbs:
                raise Refused("no_database_found")
            total = sum(db_bytes(path) for path in dbs)
            free = free_bytes(Path(self.l["backups"]))
            p.update({"databases": len(dbs), "database_bytes": total, "free_bytes": free})
            if free < int(self.l["disk_factor"]) * total:
                raise Refused(f"disk_insufficient: free={free} need={int(self.l['disk_factor']) * total}")
            self.dbs = [{"path": str(path.relative_to(self.state)), "bytes": db_bytes(path)} for path in dbs]
            p["gateway_listening"] = port_open(int(self.l["port"]))
            p["gateway_pids"] = len(self.gateway_pids())
            # Prerequisites known for 2026.10.9: compat variants on the candidate, triage guard in the start script.
            compat = self.compat_check(Path(self.l["candidate_openclaw"]))
            p["compat_candidate"] = compat
            missing = [name for name in self.l.get("compat_required", [])
                       if str(compat.get(name, "absent")).startswith(("refused", "manifest_absent", "absent"))]
            script = self.l.get("gateway_start_script")
            if script:
                text = Path(script).read_text() if Path(script).is_file() else ""
                p["triage_guard"] = bool(re.search(r"OPENCLAW_SUPERVISOR_MODE|OPENCLAW_SHELL|triage", text))
                if not p["triage_guard"]:
                    missing.append("triage_guard")
            # The Samantha plugin (Gateway and Companion) must carry the 2026.10.9 SDK row (#500) before the switch.
            dist = self.state / "extensions" / self.l["plugin_id"] / "dist"
            p["plugin_sdk_target"] = self.plugin_supports_target(dist)
            if not p["plugin_sdk_target"]:
                missing.append("plugin_sdk_target")
            missing = [m for m in missing if m not in (self.o.skip_prerequisite or [])]
            p["prerequisites_missing"] = missing
            if missing:
                raise Refused("prerequisites_missing: " + ",".join(missing))
            # Plugin baseline for the tool gate: the Samantha plugin must load on the current runtime too.
            self.doc["whatsapp"] = {"from": self.whatsapp_version()}

    def plugin_supports_target(self, dist: Path) -> bool:
        needle = '"' + self.l["target_version"] + '"'
        for path in dist.rglob("openclawSdkVersions*.js") if dist.is_dir() else []:
            with contextlib.suppress(OSError):
                if needle in path.read_text(errors="replace"):
                    return True
        return False

    # ----------------------------------------------------------------- stage
    def copy_tree(self, source: Path, target: Path) -> None:
        partial = target.with_name(target.name + ".partial")
        if partial.exists():
            shutil.rmtree(partial)  # our own interrupted copy, exact path
        shutil.copytree(source, partial, symlinks=True)
        os.replace(partial, target)

    def stage(self) -> None:
        with self.phase("stage") as p:
            for source, target, check in ((Path(self.l["candidate_openclaw"]), self.oc_cand, openclaw_version),
                                          (Path(self.l["candidate_node"]), self.node_cand, node_version)):
                if target.exists() and check(target) == check(source):
                    p[target.name] = "reused"
                    continue
                if target.exists():
                    raise Failed("stale_candidate_" + target.name)
                started = time.monotonic()
                self.copy_tree(source, target)
                p[target.name] = {"copied_ms": int((time.monotonic() - started) * 1000)}
            self.stage_whatsapp(p)

    def stage_whatsapp(self, p: dict) -> None:
        """@openclaw/whatsapp at the target version, prepared before the window in a copy of its npm project.

        OpenClaw 2026.10.9 `plugins update/install` refuses on Android: fs-safe rejects every temp workspace
        under /data (owner uid 1000). npm itself installs fine, so the copy is upgraded with npm (no peer
        install: the project's `node_modules/openclaw` link to the global OpenClaw is kept) and swapped in."""
        spec = self.l.get("whatsapp") or {}
        if spec.get("mode") != "npm":
            return
        dirs = self.whatsapp_dirs()
        if len(dirs) != 1:
            raise Failed("whatsapp_project_missing_or_ambiguous")
        source = dirs[0]
        target = self.backup / "whatsapp-candidate" / source.name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        started = time.monotonic()
        shutil.copytree(source, target, symlinks=True)
        peer = target / "node_modules/openclaw"
        peer_link = os.readlink(peer) if peer.is_symlink() else None
        cmd = list(self.l["npm"]) + ["install", spec["spec"], "--save-exact", "--legacy-peer-deps", "--no-audit",
                                     "--no-fund", "--omit=dev"]
        if self.l.get("nice"):
            cmd = ["nice", "-n", str(self.l["nice"])] + cmd
        log = self.receipts / f"openclaw-upgrade-{self.stamp}-whatsapp-npm.log"
        try:
            run = subprocess.run(cmd, cwd=target, capture_output=True, text=True, env=self.env(),
                                 timeout=float(self.l["budgets"]["whatsapp_install_s"]), stdin=subprocess.DEVNULL)
            rc, text = run.returncode, run.stdout + "\n--- stderr ---\n" + run.stderr
        except subprocess.TimeoutExpired:
            rc, text = 124, "timeout"
        fd = os.open(log, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(redact(text[-100000:]))
        self.doc.setdefault("logs", {})["whatsapp-npm"] = str(log)
        if peer_link:
            # The peer link names the live OpenClaw path (the global install in prod: unchanged by the rename
            # switch, it serves 2026.10.9 afterwards). A preprod copy pointed at prod's tree is re-aimed.
            p["peer_link_retargeted"] = os.path.realpath(peer_link) != os.path.realpath(self.oc_live)
            if peer.is_symlink() or peer.exists():
                peer.unlink()
            os.symlink(str(self.oc_live), peer)
        version = package_version(target / "node_modules/@openclaw/whatsapp/package.json")
        p["whatsapp_candidate"] = {"rc": rc, "version": version, "ms": int((time.monotonic() - started) * 1000),
                                   "peer_link_kept": bool(peer_link) and peer.is_symlink()}
        if rc != 0 or version != self.l["target_version"]:
            raise Failed(f"whatsapp_candidate_failed rc={rc}")
        self.wa_candidate = target

    # ----------------------------------------------------------------- stop / freeze
    def pause_supervisors(self) -> None:
        for pattern in self.l.get("pause_patterns") or []:
            for pid in find_pids(pattern):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGSTOP)
                    self.paused.append(pid)

    def resume_supervisors(self) -> None:
        for pid in self.paused:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGCONT)
        self.paused = []

    def same_state(self, pid: int) -> bool:
        """The process runs on THIS layout's state dir (prod and preprod Gateways never get confused)."""
        env = proc_env(pid)
        state = env.get("OPENCLAW_STATE_DIR") or (str(Path(env["HOME"]) / ".openclaw") if env.get("HOME") else "")
        return bool(state) and os.path.realpath(state) == os.path.realpath(self.state)

    def gateway_pids(self) -> set[int]:
        """Android denies /proc/net and netlink to apps: the Gateway is found by OpenClaw's owner lease, the
        process started here and the Gateway title, each checked against this layout's state dir."""
        pids = set(listening_pids(int(self.l["port"])))
        lease = lease_gateway_pid(self.state)
        if lease and self.same_state(lease):
            pids.add(lease)
        if self.gateway_child is not None and self.gateway_child.poll() is None:
            pids.add(self.gateway_child.pid)
        pattern = self.l.get("gateway_pattern")
        if pattern:
            regex, mine = re.compile(pattern), own_lineage()
            for pid in all_pids():
                if pid not in mine and regex.search(proc_cmdline(pid)) and self.same_state(pid):
                    pids.add(pid)
        return pids - own_lineage()

    def stop_gateway(self, phase: str = "stop") -> None:
        with self.phase(phase) as p:
            pids = sorted(self.gateway_pids())
            p["pids"] = len(pids)
            comp = self.l.get("companion")
            if comp:
                # The Companion loads the installed OpenClaw SDK in-process and opens the agent databases:
                # it is stopped for a consistent backup and restarted on the switched (or restored) runtime.
                p["companion"] = kill_pids(find_pids(re.escape(comp["pattern"])), 10)
                self.done["companion_stopped"] = True
            tree = sorted(set(pids) | descendants(set(pids)) | self.triage_pids())
            p.update(kill_pids(tree, float(self.l["budgets"]["stop_s"])))
            deadline = time.monotonic() + 15
            while (port_open(int(self.l["port"])) or self.gateway_pids()) and time.monotonic() < deadline:
                time.sleep(0.5)
            if port_open(int(self.l["port"])):
                raise Failed("gateway_port_still_bound")
            if self.down_at is None:
                self.down_at = time.monotonic()
                self.window_start_ticks = self.boot_ticks()
            self.done["stopped"] = True

    @staticmethod
    def boot_ticks() -> int:
        try:
            uptime = float(Path("/proc/uptime").read_text().split()[0])
            return int(uptime * os.sysconf("SC_CLK_TCK"))
        except (OSError, ValueError):
            return 0

    # ----------------------------------------------------------------- backup
    def backup_all(self) -> None:
        with self.phase("backup") as p:
            (self.backup / "db").mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.backup, 0o700)
            for entry in self.dbs:
                live = self.state / entry["path"]
                copy = self.backup / "db" / entry["path"]
                started = time.monotonic()
                sqlite_backup(live, copy)
                entry["backup_ms"] = int((time.monotonic() - started) * 1000)
                entry["backup_bytes"] = copy.stat().st_size
                entry["schema_before"] = schema_versions(copy)
                entry["sha256_backup"] = sha256(copy)
            files = self.backup / "files"
            files.mkdir(mode=0o700, exist_ok=True)
            config = Path(self.l["config"])
            shutil.copy2(config, files / "openclaw.json")
            saved = ["openclaw.json"]
            for path in sorted(self.state.glob("agents/*/agent/*.json")):
                rel = path.relative_to(self.state)
                (files / rel).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(path, files / rel)
                saved.append(str(rel))
            credentials = self.state / "credentials"
            if credentials.is_dir():
                shutil.copytree(credentials, files / "credentials", symlinks=True)
                saved.append("credentials/")
            p["files"] = len(saved)
            self.doc["backup"] = {"dir": str(self.backup), "files": saved}
            self.done["backed_up"] = True
        with self.phase("integrity") as p:
            bad = []
            for entry in self.dbs:
                started = time.monotonic()
                entry["backup_integrity"] = integrity(self.backup / "db" / entry["path"])
                entry["integrity_ms"] = int((time.monotonic() - started) * 1000)
                if not entry["backup_integrity"]:
                    bad.append(entry["path"])
            p["failed"] = bad
            self.doc["databases"] = self.dbs
            if bad:
                raise Failed("backup_integrity_failed")

    # ----------------------------------------------------------------- switch
    def switch(self) -> None:
        with self.phase("switch") as p:
            os.rename(self.oc_live, self.oc_keep)
            os.rename(self.oc_cand, self.oc_live)
            self.done["switched_openclaw"] = True
            os.rename(self.node_live, self.node_keep)
            os.rename(self.node_cand, self.node_live)
            self.done["switched_node"] = True
            p["openclaw"], p["node"] = openclaw_version(self.oc_live), node_version(self.node_live)
            if p["openclaw"] != self.l["target_version"] or p["node"] != self.l["target_node"]:
                raise Failed("switch_verification_failed")

    def doctor(self) -> None:
        with self.phase("doctor") as p:
            # OPENCLAW_SHELL=exec: a failing CLI never starts the 2026.10.9 automatic triage (claude -p / embedded turn).
            if self.l.get("lease_preflight"):
                # Existing owner: releases agent DB leases whose PID Android handed to another app.
                with contextlib.suppress(OSError, subprocess.SubprocessError):
                    run = subprocess.run(list(self.l["lease_preflight"]), capture_output=True, text=True, timeout=60)
                    p["lease_preflight_rc"] = run.returncode
            attempts = 0
            while True:
                attempts += 1
                rc, out, err, ms = self.cli(["doctor", "--fix", "--non-interactive"], float(self.l["budgets"]["doctor_s"]),
                                            {"OPENCLAW_SHELL": "exec"}, log_name=f"doctor-{attempts}")
                if rc == 0 or attempts >= 2 or "could not enter maintenance" not in (out + err):
                    break
                time.sleep(10)  # a lease still held by the process just stopped: one bounded retry
            p["rc"], p["cli_ms"], p["attempts"] = rc, ms, attempts
            p["migrated"] = len(re.findall(r"Upgraded agent database schema", out + err))
            self.done["doctor"] = True
            for entry in self.dbs:
                live = self.state / entry["path"]
                if live.exists():
                    entry["schema_after"] = schema_versions(live)
            if rc != 0:
                raise Failed(f"doctor_failed rc={rc}")

    # ----------------------------------------------------------------- WhatsApp
    def whatsapp_dirs(self) -> list[Path]:
        return sorted(p for p in (self.state / "npm/projects").glob("openclaw-whatsapp-*")
                      if (p / "node_modules/@openclaw/whatsapp/package.json").is_file())

    def whatsapp_version(self):
        versions = [package_version(p / "node_modules/@openclaw/whatsapp/package.json") for p in self.whatsapp_dirs()]
        return versions[0] if len(versions) == 1 else (versions or None)

    def whatsapp(self) -> None:
        spec = self.l.get("whatsapp") or {}
        if spec.get("mode") == "skip":
            return
        with self.phase("whatsapp") as p:
            target = self.l["target_version"]
            if spec.get("mode") == "npm" and self.wa_candidate is not None:
                # Same project directory name, new package bytes: renamed in, the old tree parked for rollback.
                live = self.state / "npm/projects" / self.wa_candidate.name
                parked = self.backup / "npm-parked"
                parked.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.rename(live, parked / live.name)
                self.done["whatsapp_parked"].append(live.name)
                os.rename(self.wa_candidate, live)
            elif self.whatsapp_version() != target:
                rc, out, err, ms = self.cli(["plugins", "update", spec["spec"]],
                                            float(self.l["budgets"]["whatsapp_install_s"]),
                                            {"OPENCLAW_SHELL": "exec"}, log_name="whatsapp")
                p["rc"], p["cli_ms"] = rc, ms
                if rc != 0:
                    raise Failed(f"whatsapp_update_failed rc={rc}")
            parked = self.backup / "npm-parked"
            for path in self.whatsapp_dirs():
                if package_version(path / "node_modules/@openclaw/whatsapp/package.json") != target:
                    parked.mkdir(parents=True, exist_ok=True, mode=0o700)
                    os.rename(path, parked / path.name)
                    self.done["whatsapp_parked"].append(path.name)
            p["parked"] = len(self.done["whatsapp_parked"])
            self.doc["whatsapp"]["to"] = self.whatsapp_version()
            if self.doc["whatsapp"]["to"] != target:
                raise Failed("whatsapp_version_mismatch")

    def consent(self) -> None:
        """2026.10.9 loads a plugin that declares capabilities with zero tools until its capabilities are accepted
        (S24 rehearsal: `requires capability consent`, Samantha 0/56 tools). Recorded offline, like doctor."""
        ids = self.l.get("consent_plugins") or []
        if not ids:
            return
        with self.phase("consent") as p:
            for plugin in ids:
                rc, out, err, ms = self.cli(["plugins", "enable", plugin, "--accept-capabilities"],
                                            float(self.l["budgets"]["cli_s"]), {"OPENCLAW_SHELL": "exec"},
                                            log_name=f"consent-{plugin}")
                p[plugin] = {"rc": rc, "cli_ms": ms}
                if rc != 0:
                    raise Failed(f"consent_failed {plugin} rc={rc}")

    # ----------------------------------------------------------------- start + gates
    def compat_apply(self) -> dict:
        """Preprod only: what gateway-start.sh does in prod before exec, on the live tree of this layout."""
        owner = Path(self.l["compat_dir"]) / "whatsapp-network-recovery.py"
        results = {}
        for name in COMPAT_SETS + ("whatsapp-network-recovery",):
            if not owner.with_name(name + ".json").is_file():
                continue
            try:
                run = subprocess.run([sys.executable, str(owner), "--patch-set", name, "--apply", "--openclaw-root",
                                      str(self.oc_live)], capture_output=True, text=True, timeout=120, env=self.env())
                doc = json.loads(run.stdout.strip().splitlines()[-1])
                results[name] = doc.get("state") if doc.get("ok") else "refused:" + str(doc.get("reason"))
            except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                results[name] = "refused:apply_failed"
        return results

    def start_gateway(self, phase: str) -> None:
        with self.phase(phase) as p:
            if self.l.get("compat_apply_on_start"):
                p["compat"] = self.compat_apply()
            log = Path(self.l["gateway_log"])
            log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(log, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.write(fd, f"--- OpenClaw gateway start by openclaw-upgrade {self.stamp} ({phase}) ---\n".encode())
            cmd = list(self.l["start"])
            if self.l.get("nice"):
                cmd = ["nice", "-n", str(self.l["nice"])] + cmd
            try:
                child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=fd, stderr=fd, env=self.env(),
                                         start_new_session=True, close_fds=True)
            finally:
                os.close(fd)
            self.gateway_pid, self.gateway_child = child.pid, child
            p["log"] = str(log)

    def gate(self, name: str, fn) -> dict:
        started = time.monotonic()
        try:
            result = fn()
        except Exception as error:  # a gate never crashes the run: it fails and rolls back
            result = {"ok": False, "detail": "exception:" + type(error).__name__}
        result["ms"] = int((time.monotonic() - started) * 1000)
        if self.o.force_gate_failure == name and result.get("ok") and not self.in_rollback:
            result.update({"ok": False, "detail": "forced_failure", "forced": True})
        self.log("gate", gate=name, ok=result.get("ok"), ms=result["ms"], detail=result.get("detail"))
        return result

    in_rollback = False

    def log_tag(self, name: str) -> str:
        return name + ("-rollback" if self.in_rollback else "")

    def gate_health_http(self) -> dict:
        deadline = time.monotonic() + float(self.l["budgets"]["health_s"])
        port = int(self.l["port"])
        while time.monotonic() < deadline:
            codes = [http_status(f"http://127.0.0.1:{port}{path}", 5) for path in self.l["health_paths"]]
            if codes and all(code == 200 for code in codes):
                return {"ok": True, "ready_ms": int((time.monotonic() - self.down_at) * 1000) if self.down_at else None}
            if self.gateway_child is not None and self.gateway_child.poll() is not None and not port_open(port):
                return {"ok": False, "detail": f"gateway_exited rc={self.gateway_child.returncode}"}
            time.sleep(1)
        return {"ok": False, "detail": "health_timeout"}

    def gate_health_json(self) -> dict:
        rc, doc, ms = self.cli_json(["health", "--json"], float(self.l["budgets"]["cli_s"]),
                                    log_name=self.log_tag("gate-health"))
        if not isinstance(doc, dict):
            return {"ok": False, "detail": f"health_json_unreadable rc={rc}"}
        plugins = doc.get("plugins") or {}
        loaded = plugins.get("loaded") or []
        errors = [e for e in plugins.get("errors") or [] if self.l["plugin_id"] in json.dumps(e)]
        ok = bool(doc.get("ok")) and self.l["plugin_id"] in loaded and not errors
        return {"ok": ok, "plugins_loaded": len(loaded), "samantha_loaded": self.l["plugin_id"] in loaded,
                "plugin_errors": len(plugins.get("errors") or []), "cli_ms": ms}

    def gate_plugin_tools(self) -> dict:
        rc, doc, ms = self.cli_json(["plugins", "inspect", self.l["plugin_id"], "--json"], float(self.l["budgets"]["cli_s"]),
                                    log_name=self.log_tag("gate-plugin"))
        plugin = (doc or {}).get("plugin") if isinstance(doc, dict) else None
        if not isinstance(plugin, dict):
            return {"ok": False, "detail": f"inspect_unreadable rc={rc}"}
        tools = len(plugin.get("toolNames") or [])
        declared = len((plugin.get("contracts") or {}).get("tools") or [])
        ok = plugin.get("status") == "loaded" and tools >= int(self.l["min_tools"])
        return {"ok": ok, "status": plugin.get("status"), "tools": tools, "declared": declared,
                "min_tools": int(self.l["min_tools"]), "cli_ms": ms}

    def gate_agent_turn(self) -> dict:
        turn = self.l["turn"]
        session = f"openclaw-upgrade-{self.stamp}-{'rollback' if self.in_rollback else 'gate'}"
        rc, out, err, ms = self.cli(["agent", "--agent", turn["agent"], "--session-id", session, "--message",
                                     turn["message"], "--json", "--timeout", str(turn["timeout_s"])],
                                    float(turn["timeout_s"]) + 60, log_name=self.log_tag("gate-turn"))
        doc = None
        start = out.find("{")
        if start >= 0:
            with contextlib.suppress(ValueError):
                doc = json.loads(out[start:])
        text = json.dumps(doc) if doc is not None else ""
        status = (doc or {}).get("status") if isinstance(doc, dict) else None
        has_reply = bool(re.search(r'"text"\s*:\s*"[^"]+', text))
        ok = rc == 0 and isinstance(doc, dict) and status in (None, "ok", "completed") and has_reply
        return {"ok": ok, "rc": rc, "status": status, "reply": has_reply, "turn_ms": ms}

    def gate_whatsapp(self) -> dict:
        rc, doc, ms = self.cli_json(["plugins", "inspect", "whatsapp", "--json"], float(self.l["budgets"]["cli_s"]),
                                    log_name=self.log_tag("gate-whatsapp-plugin"))
        plugin = (doc or {}).get("plugin") if isinstance(doc, dict) else None
        plugin = plugin if isinstance(plugin, dict) else {}
        version = plugin.get("packageVersion") or plugin.get("version")
        expected = self.l["source_version"] if self.in_rollback else self.l["target_version"]
        loaded = {"plugin_status": plugin.get("status"), "plugin_version": version}
        if plugin.get("status") != "loaded" or version != expected:
            return {"ok": False, "detail": "whatsapp_plugin_not_loaded", **loaded}
        if not self.l.get("whatsapp_gate"):
            return {"ok": True, "connected": "skipped_isolated_preprod_no_whatsapp_credentials", **loaded}
        deadline = time.monotonic() + float(self.l["budgets"]["whatsapp_connect_s"])
        last = {}
        while time.monotonic() < deadline:
            rc, doc, ms = self.cli_json(["channels", "status", "--json"], float(self.l["budgets"]["cli_s"]))
            wa = ((doc or {}).get("channels") or {}).get("whatsapp") if isinstance(doc, dict) else None
            if isinstance(wa, dict):
                last = {"running": wa.get("running"), "connected": wa.get("connected"), "linked": wa.get("linked")}
                if wa.get("connected") is True:
                    return {"ok": True, **last, **loaded}
            time.sleep(5)
        return {"ok": False, "detail": "whatsapp_not_connected", **last}

    def triage_pids(self) -> set[int]:
        """Automatic triage processes (openclaw triage, claude/codex) spawned from the Gateway's tree."""
        found = set()
        roots = self.gateway_pids()
        if self.gateway_pid and Path(f"/proc/{self.gateway_pid}").exists():
            roots.add(self.gateway_pid)
        tree = descendants(roots) if roots else set()
        for pid in all_pids():
            cmd = proc_cmdline(pid)
            if not cmd:
                continue
            st = proc_stat(pid)
            recent = st is not None and self.window_start_ticks is not None and st[1] >= self.window_start_ticks
            is_triage = re.search(r"openclaw(\.mjs)?\s+triage\b", cmd) is not None
            is_agent = re.match(r"^\S*(?:^|/)(claude|codex)(\s|$)", cmd) is not None
            if (is_triage and (recent or pid in tree)) or (is_agent and pid in tree):
                found.add(pid)
        return found - own_lineage()

    def gate_no_triage(self) -> dict:
        pids = self.triage_pids()
        hits = 0
        with contextlib.suppress(OSError):
            with open(self.l["gateway_log"], "rb") as handle:
                handle.seek(max(0, Path(self.l["gateway_log"]).stat().st_size - 4_000_000))
                tail = handle.read().decode(errors="replace")
            marker = f"openclaw-upgrade {self.stamp}"
            tail = tail[tail.rfind(marker):] if marker in tail else tail
            hits = len(re.findall(r"Automatic triage|Starting claude|openclaw triage", tail))
        stub = 0
        if self.l.get("triage_stub_log"):
            with contextlib.suppress(OSError):
                stub = sum(1 for line in Path(self.l["triage_stub_log"]).read_text().splitlines() if self.stamp in line)
        if pids:
            kill_pids(sorted(pids), 5)
        return {"ok": not pids and not hits and not stub, "processes": len(pids), "log_hits": hits, "stub_calls": stub}

    def companion_restart(self) -> dict:
        comp = self.l.get("companion")
        if not comp:
            return {"ok": True, "skipped": "no_companion_in_profile"}
        kill_pids(find_pids(re.escape(comp["pattern"])), 10)
        log = Path(self.l["receipts"]) / f"openclaw-upgrade-{self.stamp}-companion.log"
        fd = os.open(log, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            subprocess.Popen(list(comp["start"]), stdin=subprocess.DEVNULL, stdout=fd, stderr=fd, env=self.env(),
                             start_new_session=True, close_fds=True)
        finally:
            os.close(fd)
        self.done["companion_restarted"] = True
        return {"ok": True}

    def gate_companion(self) -> dict:
        comp = self.l.get("companion")
        if not comp:
            return {"ok": True, "skipped": "no_companion_in_profile"}
        deadline = time.monotonic() + float(self.l["budgets"]["companion_s"])
        base = comp["url"]
        while time.monotonic() < deadline:
            if (http_status(base + "/v1/health", 5) == 200
                    and http_status(base + "/v1/control/health?contract=2", 10) == 200
                    and http_status(base + "/v1/agent/config", 10) == 200):
                return {"ok": True}
            time.sleep(4)
        return {"ok": False, "detail": "companion_or_gateway_reads_not_ready"}

    def run_gates(self, names, record: dict) -> bool:
        table = {"health_http": self.gate_health_http, "health_json": self.gate_health_json,
                 "plugin_tools": self.gate_plugin_tools, "agent_turn": self.gate_agent_turn,
                 "whatsapp": self.gate_whatsapp, "companion": self.gate_companion, "no_triage": self.gate_no_triage}
        ok = True
        for name in names:
            record[name] = self.gate(name, table[name])
            self.write_receipt()
            if not record[name].get("ok"):
                ok = False
                if name == "health_http":
                    # Nothing else can answer; the triage evidence (log, processes) is still recorded and killed.
                    if "no_triage" in names:
                        record["no_triage"] = self.gate("no_triage", self.gate_no_triage)
                    break
        return ok

    # ----------------------------------------------------------------- rollback
    def rollback(self, reason: str) -> None:
        self.in_rollback = True
        self.doc["state"] = "rolling_back"
        self.doc["failure"] = reason
        self.log("rollback_start", reason=reason)
        rb = self.doc.setdefault("rollback", {"steps": {}})
        started = time.monotonic()
        try:
            self.stop_gateway("rollback_stop")
            with self.phase("rollback_restore") as p:
                if self.done["switched_openclaw"] and self.oc_keep.exists():
                    if self.oc_live.exists():
                        os.rename(self.oc_live, self.oc_live.with_name(
                            f"{self.oc_live.name}.failed-{self.l['target_version']}-{self.stamp}"))
                    os.rename(self.oc_keep, self.oc_live)
                if self.done["switched_node"] and self.node_keep.exists() and self.l.get("rollback_node") == "restore":
                    if self.node_live.exists():
                        os.rename(self.node_live, self.node_live.with_name(f"{self.node_live.name}.failed-{self.stamp}"))
                    os.rename(self.node_keep, self.node_live)
                p["openclaw"], p["node"] = openclaw_version(self.oc_live), node_version(self.node_live)
                if self.done["backed_up"]:
                    files = self.backup / "files"
                    restored = []
                    for entry in self.dbs:
                        restore_db(self.backup / "db" / entry["path"], self.state / entry["path"])
                        entry["restored_sha_ok"] = sha256(self.state / entry["path"]) == entry["sha256_backup"]
                        restored.append(entry["restored_sha_ok"])
                    copy_atomic(files / "openclaw.json", Path(self.l["config"]))
                    for path in sorted(files.glob("agents/*/agent/*.json")):
                        copy_atomic(path, self.state / path.relative_to(files))
                    if (files / "credentials").is_dir():
                        live = self.state / "credentials"
                        if live.exists():
                            os.rename(live, self.backup / f"credentials.failed-{self.stamp}")
                        shutil.copytree(files / "credentials", live, symlinks=True)
                    p["databases_restored"], p["sha_all_equal"] = len(restored), all(restored)
                    if not all(restored):
                        raise Failed("restored_sha_mismatch")
                for name in self.done["whatsapp_parked"]:
                    for path in self.whatsapp_dirs():
                        if package_version(path / "node_modules/@openclaw/whatsapp/package.json") == self.l["target_version"]:
                            failed = self.backup / "npm-failed"
                            failed.mkdir(parents=True, exist_ok=True, mode=0o700)
                            os.rename(path, failed / path.name)
                    os.rename(self.backup / "npm-parked" / name, self.state / "npm/projects" / name)
                p["whatsapp"] = self.whatsapp_version()
            if self.done["companion_restarted"] or self.done["companion_stopped"]:
                rb["steps"]["companion"] = self.companion_restart()
            self.start_gateway("rollback_start")
            gates = rb.setdefault("gates", {})
            healthy = self.run_gates(["health_http", "health_json", "agent_turn", "whatsapp", "companion", "no_triage"], gates)
            rb["downtime_ms"] = int((time.monotonic() - self.down_at) * 1000) if self.down_at else 0
            rb["ms"] = int((time.monotonic() - started) * 1000)
            # (c) integrity of the restored live databases, read-only next to the restarted Gateway.
            with self.phase("rollback_integrity") as p:
                bad = [e["path"] for e in self.dbs if self.done["backed_up"] and not integrity(self.state / e["path"])]
                p["failed"] = bad
            healthy = healthy and not bad
            self.doc["state"] = "rolled_back" if healthy else "rollback_failed"
        except Exception as error:
            self.doc["state"] = "rollback_failed"
            rb["error"] = redact(f"{type(error).__name__}: {error}")[:300]
        if self.doc["state"] == "rollback_failed" and self.l.get("notify"):
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                subprocess.run(list(self.l["notify"]) + ["Samantha — montée OpenClaw annulée mais le retour arrière n'est pas sain."],
                               timeout=30, capture_output=True)

    # ----------------------------------------------------------------- main
    def prune(self) -> None:
        """Bounded: keep the newest backup sets and rollback trees of this owner, exact names only."""
        keep = max(1, int(self.l["keep_backups"]))
        root = Path(self.l["backups"])
        sets = sorted((p for p in root.glob("openclaw-upgrade-*") if p.is_dir() and STAMP_RE.match(p.name[17:])),
                      key=lambda p: p.name)
        for path in sets[:-keep]:
            shutil.rmtree(path)
        for live in (self.oc_live, self.node_live):
            pattern = re.compile(re.escape(live.name) + r"\.(rollback|failed)-.*\d{8}T\d{6}$")
            old = sorted((p for p in live.parent.iterdir() if pattern.fullmatch(p.name) and p.is_dir()),
                         key=lambda p: p.name[-15:])
            for path in old[:-keep]:
                shutil.rmtree(path)

    def run(self) -> int:
        code = 0
        try:
            self.preflight()
            if self.o.dry_run:
                self.doc["state"] = "dry_run_ok"
                return 0
            self.prune()
            self.stage()
            self.pause_supervisors()
            self.stop_gateway()
            self.backup_all()
            self.switch()
            self.doctor()
            self.whatsapp()
            self.consent()
            if self.l.get("companion"):
                with self.phase("companion_restart") as p:
                    p.update(self.companion_restart())
            self.start_gateway("start")
            if not self.run_gates(list(GATES), self.doc["gates"]):
                failed = [n for n, g in self.doc["gates"].items() if not g.get("ok")]
                raise Failed("gate_failed: " + ",".join(failed))
            self.doc["downtime_ms"] = self.doc["gates"]["health_http"].get("ready_ms")
            self.doc["state"] = "deployed"
        except Refused as error:
            self.doc["state"], self.doc["detail"], code = "refused", redact(str(error))[:300], 4
        except Exception as error:
            reason = redact(f"{type(error).__name__}: {error}")[:300]
            if self.done["stopped"]:
                self.rollback(reason)
                code = 6
            else:
                self.doc["state"], self.doc["detail"], code = "failed", reason, 5
        finally:
            self.resume_supervisors()
            self.write_receipt()
            if self.lock_fd is not None:
                os.close(self.lock_fd)
        return code


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", choices=("prod", "staging"), required=True)
    ap.add_argument("--layout", help="JSON overriding the profile layout (tests, other roots)")
    ap.add_argument("--dry-run", action="store_true", help="preflight only, nothing stopped or changed")
    ap.add_argument("--force-gate-failure", choices=GATES, help="rehearsal: fail this gate to exercise the rollback")
    ap.add_argument("--skip-prerequisite", action="append", help="rehearsal: accept a known missing prerequisite")
    ap.add_argument("--stamp", help=argparse.SUPPRESS)
    ap.add_argument("--status", action="store_true", help="print the last receipt")
    options = ap.parse_args(argv)
    if options.force_gate_failure and options.profile == "prod":
        print("force_gate_failure_refused_in_prod", file=sys.stderr)
        return 2
    layout = load_layout(options.profile, options.layout, dict(os.environ))
    if options.status:
        receipts = sorted(Path(layout["receipts"]).glob("openclaw-upgrade-*[0-9].json"))
        print(receipts[-1].read_text() if receipts else "{}")
        return 0
    upgrade = Upgrade(layout, options)
    code = upgrade.run()
    print(str(upgrade.receipt_path))
    return code


if __name__ == "__main__":
    sys.exit(main())
