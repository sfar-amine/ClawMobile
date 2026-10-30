#!/usr/bin/env python3
"""One owner-brain turn right after each Gateway start, so Amine's first message never pays the cold start.

S24 logs 29-30/10: after every Gateway start, the first main-agent run blocked the whole Gateway 41-62 s
(« liveness heartbeat delayed », WhatsApp dropped with 408) and then spent 8-10 s loading plugin tools; the
second run of the same process was warm (8.2 s end to end). Deploy acceptance 30/10: owner_read 65.6 s.

gateway-start.sh launches this detached before exec'ing the Gateway (--after-start); companion-deploy.sh runs it
once more before the five paths and returns as soon as this Gateway process is warm. One turn per Gateway
process, no retry, nothing delivered, no tool: the receipt is ~/.openclaw/health/brain-warm.json.
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
START_WAIT_S, SETTLE_S, TURN_TIMEOUT_S = 240, 20, 200


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


def warm(*, after_start, pid_of=gateway_pid, is_open=port_open, turn=owner_turn, sleep=time.sleep,
         clock=time.time, receipt=RECEIPT, lock=LOCK):
    lock.parent.mkdir(parents=True, exist_ok=True)
    with open(lock, "a") as held:
        # A deploy that arrives while the start-time warm-up runs waits for it instead of starting a second turn.
        fcntl.flock(held, fcntl.LOCK_EX)
        if after_start:
            deadline = clock() + START_WAIT_S
            while not (pid_of() and is_open()) and clock() < deadline:
                sleep(2)
            sleep(SETTLE_S)  # startup sidecars first; the warm turn is never the Gateway's first request
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
    if argv[1:] not in ([], ["--after-start"]):
        print("usage: brain-warm.py [--after-start]", file=sys.stderr)
        return 2
    doc, code = warm(after_start=argv[1:] == ["--after-start"])
    print(json.dumps(doc, ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
