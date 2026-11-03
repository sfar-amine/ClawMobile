#!/usr/bin/env python3
"""One owner-brain turn after a deploy's promotion, so the acceptance paths and Amine meet a warm brain.

S24 logs 29-30/10: after every Gateway start, the first main-agent run blocked the whole Gateway 41-62 s
(« liveness heartbeat delayed », WhatsApp dropped with 408) and then spent 8-10 s loading plugin tools; the
second run of the same process was warm (8.2 s end to end). Deploy acceptance 30/10: owner_read 65.6 s.

companion-deploy.sh runs it after the Tier0 promotion, before the five paths. Never at Gateway start: on 30/10 the
start-time warm turn blocked the Gateway 61 s inside Tier0's 120 s activation readiness window, the health manager
restarted too late and the promotion of 986187b7 failed (activation_readiness_failed, rolled back). One turn per
Gateway process, no retry, nothing delivered, no tool: the receipt is ~/.openclaw/health/brain-warm.json.
Exit 0 = warm (or already warm), 1 = the turn failed, 2 = usage, 3 = no Gateway to warm.
"""
import fcntl, json, os, socket, subprocess, sys, time
from pathlib import Path

HOME = Path(os.environ.get("HOME", "/data/data/com.termux/files/home"))
RECEIPT = HOME / ".openclaw/health/brain-warm.json"
LOCK = HOME / ".openclaw/health/brain-warm.lock"
SESSION = "agent:main:brain-warm"
MESSAGE = "Préchauffage technique après un redémarrage : réponds seulement OK, sans outil."
PORT = int(os.environ.get("CLAWMOBILE_GATEWAY_PORT") or 18789)
TURN_TIMEOUT_S = 200


def gateway_pid(run=subprocess.run):
    """The running Gateway process: one warm turn belongs to exactly one process."""
    try:
        out = run(["pgrep", "-f", "openclaw-gateway"], capture_output=True, text=True, timeout=5).stdout.split()
        return int(out[0]) if out else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def port_open(port=PORT):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def read_receipt(path=RECEIPT):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_receipt(doc, path=RECEIPT):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False))
    os.replace(tmp, path)


def owner_turn(run=subprocess.run):
    """The same owner-brain entry as the deploy paths, in its own session; no delivery."""
    began = time.monotonic()
    try:
        p = run(["openclaw", "agent", "--agent", "main", "--session-key", SESSION, "--message", MESSAGE,
                 "--json", "--timeout", str(TURN_TIMEOUT_S - 20)], capture_output=True, text=True, timeout=TURN_TIMEOUT_S)
        value = json.loads(p.stdout or "{}")
        error = None if value.get("status") == "ok" else str(value.get("error") or value.get("status") or p.returncode)[:120]
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        error = type(e).__name__
    return round(time.monotonic() - began, 1), error


def warm(*, pid_of=gateway_pid, is_open=port_open, turn=owner_turn, clock=time.time,
         receipt=RECEIPT, lock=LOCK):
    lock.parent.mkdir(parents=True, exist_ok=True)
    with open(lock, "a") as held:
        # Two callers at once (a manual run during a deploy) share one turn instead of starting a second one.
        fcntl.flock(held, fcntl.LOCK_EX)
        pid = pid_of()
        if not pid or not is_open():
            return {"state": "no_gateway"}, 3
        done = read_receipt(receipt)
        if done.get("gatewayPid") == pid and done.get("state") == "warm":
            return {**done, "reused": True}, 0
        seconds, error = turn()
        doc = {"gatewayPid": pid, "state": "failed" if error else "warm", "seconds": seconds,
               "at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(clock())),
               **({"error": error} if error else {})}
        write_receipt(doc, receipt)
        return doc, 1 if error else 0


def main(argv):
    if argv[1:]:
        print("usage: brain-warm.py", file=sys.stderr)
        return 2
    doc, code = warm()
    print(json.dumps(doc, ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
