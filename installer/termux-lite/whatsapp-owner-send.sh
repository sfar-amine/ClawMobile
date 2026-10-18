#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
# Private QA extension delegates authorization and delivery to the existing people
# owner. Payloads stay on stdin; no recipient or content is added to argv/logs.
if [ "${1:-}" = "--qa-delivery-stdin" ]; then
  if [ "$#" -ne 1 ]; then
    printf '%s\n' '{"state":"NOT_SENT","reason":"qa_delivery_input_invalid"}'
    exit 0
  fi
  qa_owner="$(cd "$(dirname "$0")" && pwd)/people-trusted.py"
  exec python3 - "$qa_owner" 3<&0 <<'QA_TRANSPORT'
import json, os, select, signal, subprocess, sys, time


def answer(state, reason=None, message_id=None):
    value = {"state": state}
    if reason:
        value["reason"] = reason
    if message_id:
        value["message_id"] = message_id
    print(json.dumps(value, separators=(",", ":")))


def cleanup(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=1)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=1)


payload = bytearray()
deadline = time.monotonic() + 2
while True:
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not select.select([3], [], [], remaining)[0]:
        answer("NOT_SENT", "qa_delivery_input_invalid")
        sys.exit(0)
    part = os.read(3, min(8192, 65537 - len(payload)))
    if not part:
        break
    payload.extend(part)
    if len(payload) > 65536:
        answer("NOT_SENT", "qa_delivery_input_invalid")
        sys.exit(0)
os.close(3)
if not payload or not os.path.isfile(sys.argv[1]):
    answer("NOT_SENT", "qa_delivery_owner_unavailable" if payload else "qa_delivery_input_invalid")
    sys.exit(0)
try:
    process = subprocess.Popen([sys.executable, sys.argv[1], "qa-deliver", "--request-stdin"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True)
except OSError:
    answer("NOT_SENT", "qa_delivery_owner_unavailable")
    sys.exit(0)

# Nonblocking bounded pipe IO prevents either a blocked child or an oversized
# response from defeating the one-invocation budget. No raw output is relayed.
os.set_blocking(process.stdin.fileno(), False)
os.set_blocking(process.stdout.fileno(), False)
response = bytearray()
sent = 0
input_open = True
output_open = True
deadline = time.monotonic() + 20
try:
    while input_open or output_open or process.poll() is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        readable, writable, _ = select.select(
            [process.stdout.fileno()] if output_open else [],
            [process.stdin.fileno()] if input_open else [], [], min(remaining, 0.1))
        if writable:
            try:
                sent += os.write(process.stdin.fileno(), payload[sent:])
            except BrokenPipeError:
                input_open = False
            if sent == len(payload) or not input_open:
                process.stdin.close()
                input_open = False
        if readable:
            part = os.read(process.stdout.fileno(), 4097 - len(response))
            if not part:
                process.stdout.close()
                output_open = False
            else:
                response.extend(part)
                if len(response) > 4096:
                    raise ValueError("response_limit")
    if process.returncode != 0:
        raise ValueError("child_result_unknown")
    result = json.loads(response)
    if not isinstance(result, dict) or result.get("state") not in {"ACCEPTED", "NOT_SENT", "UNKNOWN"}:
        raise ValueError("receipt_invalid")
    state = result["state"]
    if state == "ACCEPTED":
        import re
        mid = result.get("message_id")
        if not isinstance(mid, str) or not re.fullmatch(r"[A-Za-z0-9_.:@-]{1,300}", mid):
            raise ValueError("receipt_invalid")
        answer("ACCEPTED", message_id=mid)
    else:
        # Reasons are closed wrapper codes; never reflect an owner exception/body.
        answer(state, "qa_delivery_not_sent" if state == "NOT_SENT" else "qa_delivery_receipt_unconfirmed")
except (OSError, ValueError, TimeoutError, subprocess.SubprocessError):
    cleanup(process)
    answer("UNKNOWN", "qa_delivery_receipt_unconfirmed")
QA_TRANSPORT
fi

STATE_DIR="$HOME/.openclaw/health"
STATE_LOG="$STATE_DIR/whatsapp-outbound.log"
mkdir -p "$STATE_DIR"
message="${1:-}"
key="${2:-}"
[ -n "$message" ] && [ -n "$key" ] || exit 64
case "$key" in *[!A-Za-z0-9._:-]*) exit 64;; esac

target="$(python3 - "$HOME/.openclaw/openclaw.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    cfg = json.load(f)
for value in cfg.get("commands", {}).get("ownerAllowFrom", []):
    if isinstance(value, str) and value.startswith("whatsapp:"):
        print(value.split(":", 1)[1])
        break
PY
)"
if [ -z "$target" ]; then
  printf '%s state=failed reason=no_owner_target key=%s\n' "$(date -Iseconds)" "$key" >>"$STATE_LOG"
  exit 66
fi
params="$(python3 - "$target" "$message" "$key" <<'PY'
import json, sys
print(json.dumps({
    "to": sys.argv[1],
    "message": sys.argv[2],
    "channel": "whatsapp",
    "accountId": "default",
    "idempotencyKey": sys.argv[3],
}, ensure_ascii=False))
PY
)"
started="$(date +%s)"
set +e
out="$(timeout 15 openclaw gateway call send --timeout 10000 --json --params "$params")"
rc=$?
set -e
elapsed=$(( $(date +%s) - started ))
if [ "$rc" -ne 0 ]; then
  printf '%s state=failed reason=gateway_call rc=%s elapsed_s=%s key=%s\n' "$(date -Iseconds)" "$rc" "$elapsed" "$key" >>"$STATE_LOG"
  exit "$rc"
fi
message_id="$(printf '%s' "$out" | python3 -c 'import json,sys; o=json.load(sys.stdin); m=o.get("messageId"); assert o.get("channel")=="whatsapp" and isinstance(m,str) and m; print(m)' 2>/dev/null || true)"
if [ -z "$message_id" ]; then
  printf '%s state=failed reason=invalid_response elapsed_s=%s key=%s\n' "$(date -Iseconds)" "$elapsed" "$key" >>"$STATE_LOG"
  exit 67
fi
printf '%s state=accepted elapsed_s=%s key=%s message_id=%s\n' "$(date -Iseconds)" "$elapsed" "$key" "$message_id" >>"$STATE_LOG"
printf '%s\n' "$message_id"