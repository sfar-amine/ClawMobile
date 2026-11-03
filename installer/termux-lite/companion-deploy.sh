#!/data/data/com.termux/files/usr/bin/bash
# Safe Companion deploy on the S24: preflight (one heavy job at a time, memory headroom), backup, build,
# restart, acceptance (companion-acceptance.py), runtime copies brought to the same commit (runtime-sync.sh:
# Gateway plugin, Tier0 release, deploy tools), automatic rollback on regression (judged on identity and
# health, recorded in rollback_acceptance), receipt.
# Runs detached: restarting the Companion drops the Claw link, so the caller polls the receipt file.
#   companion-deploy.sh <commit>        deploy that commit of samantha-private/runtime/samantha-companion-private
#   COMPANION_DEPLOY_WAIT_CALM_S=1200   wait up to that long for a calm phone instead of refusing at once
#   COMPANION_DEPLOY_LOCK_WAIT_S=10     wait 0..600 s for the existing deploy/campaign lock
#   companion-deploy.sh --status        print the last receipt
#   companion-deploy.sh --resolve       print the resolved runtime root and checkout, change nothing
#   companion-deploy.sh --maintenance close|open|status   maintenance lock of SAM-MIG V2.2 (see below)
set -uo pipefail
# A deploy always reads the git checkout: REPO is fetched from and fast-forwarded, so `$ROOT/../..` has to be a
# repository. tier0-bootstrap.sh exports CLAW_RUNTIME_ROOT at the Tier0 release it pinned, by design, so that the
# daemons it starts run that release; every process it spawns inherits it, Gateway and Claw bridge included. A
# release copy is not a checkout, and runtime-sync.sh prunes it later, so an inherited value sends this script
# outside any repository and the deploy dies on `fetch_failed` with nothing to point at (S24 17/10, 18:57).
# Same fallback as runtime-sync.sh: honour the override only when it really carries a checkout.
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
[ -e "$ROOT/../../.git" ] || ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(CDPATH= cd -- "$ROOT/../.." && pwd)"
# Fail closed and say why, rather than letting `git fetch` report a bare `fetch_failed` two steps later.
[ -e "$REPO/.git" ] || { echo "deploy_requires_checkout: $REPO is not a git checkout" >&2; exit 2; }
PLUGIN="$REPO/openclaw-plugin-mobile-ui"
# The acceptance check is the one carried by the checkout being judged (target after the fast-forward,
# previous after a rollback), so every lot's acceptance lines run. The copy next to this script is only
# a fallback for a checkout that does not carry it yet. A rollback is not judged by it (R03, see rollback()).
ACCEPT_FALLBACK="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/companion-acceptance.py"
accept(){ script="$ACCEPT_FALLBACK"; [ -f "$ROOT/companion-acceptance.py" ] && script="$ROOT/companion-acceptance.py"
  if [ -n "${BASELINE_RECEIPT:-}" ]; then python3 "$script" --baseline "$BASELINE_RECEIPT"; else python3 "$script"; fi; }
STATE="$HOME/.openclaw/deploys"; BACKUPS="$HOME/.openclaw/backups"
REMOTE="${COMPANION_DEPLOY_REMOTE:-samantha-private}"; BRANCH="${COMPANION_DEPLOY_BRANCH:-runtime/samantha-companion-private}"
KEEP_BACKUPS="${COMPANION_DEPLOY_KEEP:-5}"; MIN_AVAILABLE_MB="${COMPANION_DEPLOY_MIN_MB:-1200}"; MAX_LOAD="${COMPANION_DEPLOY_MAX_LOAD:-7}"
mkdir -p "$STATE" "$BACKUPS"; chmod 700 "$STATE"

if [ "${1:-}" = "--status" ]; then ls -t "$STATE"/companion-*.json 2>/dev/null | head -1 | xargs -r cat; exit 0; fi
# Read-only: lets test-companion-deploy-root.py prove the resolution above without running a deploy.
if [ "${1:-}" = "--resolve" ]; then printf '{"root":"%s","repo":"%s"}\n' "$ROOT" "$REPO"; exit 0; fi
# SAM-MIG V2.2 §12.1 — minimal maintenance lock. This script is the ONLY writer of the durable marker read by the
# dialogue coordinator at admission and again at the hand-off point. A restart never lifts it (it is a file).
#   companion-deploy.sh --maintenance close [--allow conv-…]…   new epoch, every new request refused (D-B);
#                                                               --allow: acceptance conversations (B-14)
#   companion-deploy.sh --maintenance open                      reopen this epoch; older messages render stale
#   companion-deploy.sh --maintenance open --expected-epoch N --expected-revision HEX32  scoped CAS
#   companion-deploy.sh --maintenance status|capabilities
# The WhatsApp channel is never stopped: each message gets the deterministic maintenance reply and OpenClaw marks it
# completed, so nothing is delivered late after the reopening.
if [ "${1:-}" = "--maintenance" ]; then
  shift
  DIALOGUE_HOME="${CLAW_DIALOGUE_HOME:-$HOME/.openclaw/samantha-dialogue}"
  [ ! -L "$DIALOGUE_HOME" ] || { echo "maintenance_path_invalid" >&2; exit 2; }
  mkdir -p "$DIALOGUE_HOME" || exit 2
  chmod 700 "$DIALOGUE_HOME" || exit 2
  python3 - "$DIALOGUE_HOME" "$STATE" "$@" <<'PY'
import fcntl, json, os, re, stat, sys, time, uuid
home, state_dir, args = sys.argv[1], sys.argv[2], sys.argv[3:]

def refuse(cause, code=2):
    print(cause, file=sys.stderr); sys.exit(code)

action = args[0] if args else "status"
allow, expected_epoch, expected_revision = [], None, None
index = 1
while index < len(args):
    flag = args[index]
    if index + 1 >= len(args): refuse("maintenance_arguments_invalid")
    value = args[index + 1]
    if flag == "--allow" and action == "close" and re.fullmatch(r"conv-[a-f0-9]{24}", value):
        allow.append(value)
    elif flag == "--expected-epoch" and action == "open" and expected_epoch is None \
            and re.fullmatch(r"0|[1-9][0-9]{0,18}", value):
        expected_epoch = int(value)
    elif flag == "--expected-revision" and action == "open" and expected_revision is None \
            and re.fullmatch(r"[a-f0-9]{32}", value):
        expected_revision = value
    else:
        refuse("maintenance_arguments_invalid")
    index += 2
if action not in {"close", "open", "status", "capabilities"} or len(allow) > 16 \
        or ((expected_revision is None) != (expected_epoch is None)):
    refuse("maintenance_arguments_invalid")
raw_wait = os.environ.get("COMPANION_MAINTENANCE_LOCK_WAIT_S", "10")
if not re.fullmatch(r"0|[1-9][0-9]{0,2}", raw_wait) or int(raw_wait) > 600:
    refuse("maintenance_lock_wait_invalid")
# Same existing lock and writer. A safe open avoids truncating a substituted
# lock/marker; no external flock option depends on the Termux PATH.
try:
    directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = os.open("maintenance.lock", os.O_CREAT | os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW,
                   0o600, dir_fd=directory)
    info = os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        refuse("maintenance_lock_invalid")
except OSError:
    refuse("maintenance_path_invalid")
deadline = time.monotonic() + int(raw_wait)
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB); break
    except BlockingIOError:
        if time.monotonic() >= deadline: refuse("maintenance_marker_busy", 3)
        time.sleep(0.2)
if action == "capabilities":
    print(json.dumps({"version": 1, "owner": "companion-deploy.sh",
                      "expected_epoch_open": True, "expected_revision_open": True})); sys.exit(0)
try:
    fd = os.open("maintenance.json", os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16384 or info.st_nlink != 1:
            raise ValueError("invalid_marker")
        current = json.load(source)
    if (not isinstance(current, dict) or current.get("state") not in {"open", "closed"}
            or type(current.get("epoch")) is not int or not 0 <= current["epoch"] < 2**63
            or ("revision" in current and not re.fullmatch(r"[a-f0-9]{32}", str(current["revision"])))):
        raise ValueError("invalid_marker")
except FileNotFoundError:
    current = {"state": "open", "epoch": 0, "changedAt": 0}
except (OSError, ValueError):
    current = {"state": "closed", "epoch": None, "invalid": True}
if action == "status":
    print(json.dumps(current, ensure_ascii=False)); sys.exit(0)
if current.get("invalid") and action == "open":
    refuse("maintenance_marker_invalid: close it again before opening")
epoch = int(current.get("epoch") or 0)
if expected_epoch is not None and (epoch != expected_epoch or
        (expected_revision is not None and current.get("revision") != expected_revision)):
    refuse("maintenance_epoch_mismatch", 4)
# Repeating the same scoped open is a read, not a new maintenance transition.
if expected_epoch is not None and current.get("state") == "open":
    print(json.dumps({"state": "open", "epoch": epoch, "revision": current.get("revision"),
                      "unchanged": True})); sys.exit(0)
now = int(time.time() * 1000)
value = {"state": "closed" if action == "close" else "open",
         "epoch": epoch + 1 if action == "close" and current.get("state") != "closed" else epoch,
         "revision": uuid.uuid4().hex if action == "close" else current.get("revision"),
         "changedAt": now, "by": "companion-deploy.sh", "acceptance": allow}
# Existing legacy markers can be opened without introducing a null revision.
if value["revision"] is None: del value["revision"]
name = "maintenance.json.next-" + uuid.uuid4().hex
fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=directory)
with os.fdopen(fd, "w") as out:
    json.dump(value, out); out.flush(); os.fsync(out.fileno())
os.replace(name, "maintenance.json", src_dir_fd=directory, dst_dir_fd=directory)
stamp = time.strftime("%Y%m%dT%H%M%S")
receipt = os.path.join(state_dir, f"maintenance-{stamp}.json")
with open(receipt, "w") as out:
    json.dump({"version": 1, "action": action, "previous": current, "marker": value}, out, ensure_ascii=False)
print(json.dumps({"state": value["state"], "epoch": value["epoch"], "revision": value.get("revision"),
                  "previous_state": current.get("state"), "previous_epoch": current.get("epoch"),
                  "receipt": receipt}))
PY
  exit $?
fi
target="${1:-}"; [[ "$target" =~ ^[0-9a-f]{7,40}$ ]] || { echo "usage: $0 <commit>|--status|--maintenance close|open|status" >&2; exit 2; }

# Q12: a QA campaign holds this SAME lock shared, from dispatch until cleanup.
# Never fetch/build/restart while either a campaign or another deploy owns it.
# Use -n (available on the S24), not flock -w; never replay a deployment later.
deploy_lock_wait="${COMPANION_DEPLOY_LOCK_WAIT_S-10}"
if ! [[ "$deploy_lock_wait" =~ ^(0|[1-9][0-9]{0,2})$ ]] || [ "$deploy_lock_wait" -gt 600 ]; then
  echo "deploy_lock_wait_invalid: expected integer seconds 0..600" >&2; exit 2
fi
exec 9>"$STATE/companion-deploy.lock" || { echo "deploy_lock_unavailable: cannot open existing lock" >&2; exit 3; }
if [ "$deploy_lock_wait" -eq 0 ]; then
  flock -n 9; deploy_lock_result=$?
else
  # The deadline covers flock itself too; counting sleeps would exceed the budget
  # when a loaded phone takes time to start each command. FD 9 refers to the same
  # open-file description in parent and children, so a successful flock stays held.
  timeout "${deploy_lock_wait}s" bash -c '
    while true; do
      flock -n 9; result=$?
      [ "$result" -eq 0 ] && exit 0
      [ "$result" -eq 1 ] || exit 2
      sleep 0.2
    done'
  deploy_lock_result=$?
fi
if [ "$deploy_lock_result" -ne 0 ]; then
  if [ "$deploy_lock_result" -eq 1 ] || [ "$deploy_lock_result" -eq 124 ]; then
    echo "deploy_already_running: deploy_lock_busy (deployment or protected campaign); wait_budget=${deploy_lock_wait}s" >&2
  else
    echo "deploy_lock_unavailable: flock or bounded wait failed" >&2
  fi
  exit 3
fi
export SAMANTHA_DEPLOY_LOCK_FD=9
stamp="$(date +%Y%m%dT%H%M%S)"; receipt="$STATE/companion-$stamp.json"; log="$STATE/companion-$stamp.log"
# The latest successful receipt is the measured previous release. Refused and rollback receipts do not
# describe the currently running target and are intentionally ignored.
BASELINE_RECEIPT="$(python3 - "$STATE" <<'PY'
import json,pathlib,sys
for path in sorted(pathlib.Path(sys.argv[1]).glob('companion-*.json'),key=lambda p:p.stat().st_mtime,reverse=True):
 try:
  doc=json.loads(path.read_text()); value=doc.get('acceptance')
  if doc.get('state')=='deployed' and value and (isinstance(value,dict) or isinstance(value,str)):
   print(path);break
 except (OSError,ValueError): pass
PY
)"
write(){ python3 - "$receipt" "$@" <<'PY'
import json,sys,datetime
path,state,target,previous,detail=sys.argv[1:6]
def arg(i):
    try: return json.loads(sys.argv[i]) if len(sys.argv)>i and sys.argv[i] else None
    except ValueError: return None
acc,runtime,rollback_acc=arg(6),arg(7),arg(8)
doc={"version":1,"state":state,"target":target,"previous":previous,"detail":detail,"acceptance":acc,"runtime":runtime,
     "at":datetime.datetime.now(datetime.timezone.utc).isoformat()}
# R03: a rollback is judged on identity and availability, kept apart from the acceptance that failed.
if rollback_acc is not None: doc["rollback_acceptance"]=rollback_acc
try: parcours=json.loads(__import__("os").environ.get("PARCOURS_JSON") or "null")
except ValueError: parcours={"state":"unreadable"}
if parcours is not None: doc["parcours"]=parcours
json.dump(doc,open(path,"w"),ensure_ascii=False)
PY
  # Only ordinary logs are bounded. Canonical JSON receipts are never removed.
  python3 "$ROOT/bounded-log.py" "$log" || true
  python3 "$ROOT/bounded-log.py" "$STATE" --deployment-logs || true
}
health(){ for _ in $(seq 1 60); do curl -fsS -m 3 http://127.0.0.1:8765/v1/health >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
# The Companion is started with the lock fd closed: otherwise it inherits it and holds the deploy lock forever.
restart(){ pkill -f 'dist/companion/server.js' 2>/dev/null; sleep 3
  pgrep -f 'dist/companion/server.js' >/dev/null || { CLAWMOBILE_DEPLOY_CANDIDATE="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" nohup "$ROOT/companion-server.sh" >>"$log" 2>&1 </dev/null & } 9>&-
  health || return 1
  # Settle before judging: Gateway session ready and load back under the preflight ceiling (bounded, 3 min).
  gateway_ready || echo "settle: gateway_not_ready" >>"$log"
  wait_calm 180 "$MAX_LOAD" || echo "settle: load_still_high=$(load1)" >>"$log"
  return 0; }

# Doc 51 / retro 12/10: the acceptance used to run while the phone was still loaded and the Gateway not yet
# ready after the restart (metadata 503, /agent/config 9.5 s): two false rollbacks and one false "rollback not
# healthy" alert. The deploy now waits for a calm phone, both before and after the restart.
load1(){ l=$(uptime 2>/dev/null | sed -n 's/.*load average: *\([0-9.]*\).*/\1/p'); echo "${l:-0}"; }
calm(){ awk -v l="$(load1)" -v m="$1" 'BEGIN{exit !(l<=m)}'; }
wait_calm(){ limit="$1"; max="$2"; waited=0; ok=0
  while [ "$waited" -lt "$limit" ]; do
    if calm "$max"; then ok=$((ok+1)); [ "$ok" -ge 3 ] && return 0; else ok=0; fi
    sleep 10; waited=$((waited+10))
  done; return 1; }
# Gateway-backed reads answer again (not 503) before they are judged. S24 26/10 11:33: /control/health answered
# 200 while the Gateway was still starting (startup-sidecars-pending until 11:34:59); /agent/config, metadata,
# WhatsApp and automations answered 503 and the deploy rolled back. Ready means a Gateway-backed read answers too.
GATEWAY_READY_TRIES="${COMPANION_DEPLOY_GATEWAY_READY_TRIES:-45}"
case "$GATEWAY_READY_TRIES" in ''|*[!0-9]*) GATEWAY_READY_TRIES=45;; esac
gateway_ready(){ for _ in $(seq 1 "$GATEWAY_READY_TRIES"); do
  control=$(curl -s -o /dev/null -w '%{http_code}' -m 10 'http://127.0.0.1:8765/v1/control/health?contract=2' 2>/dev/null)
  agent=$(curl -s -o /dev/null -w '%{http_code}' -m 10 'http://127.0.0.1:8765/v1/agent/config' 2>/dev/null)
  [ "$control" = 200 ] && [ "$agent" = 200 ] && return 0; sleep 4; done; return 1; }
WAIT_CALM_S="${COMPANION_DEPLOY_WAIT_CALM_S:-0}"
[ "$WAIT_CALM_S" -gt 0 ] && wait_calm "$WAIT_CALM_S" "$MAX_LOAD" >/dev/null 2>&1 || true

# Preflight: never stack a deploy on a heavy job (Gradle, another build) or on a phone short of memory.
MEMINFO_FILE="${COMPANION_DEPLOY_MEMINFO_FILE:-/proc/meminfo}"
BATTERY_STATUS_FILE="${COMPANION_DEPLOY_BATTERY_STATUS_FILE:-/sys/class/power_supply/battery/status}"
available=$(awk '/MemAvailable/{print int($2/1024)}' "$MEMINFO_FILE"); # /proc/loadavg is denied to detached processes on Android: read the 1-minute load from uptime.
load=$(uptime 2>/dev/null | sed -n 's/.*load average: *\([0-9.]*\).*/\1/p'); load="${load:-0}"
battery_status=$(cat "$BATTERY_STATUS_FILE" 2>/dev/null || true)
if [ -z "$battery_status" ] && command -v dumpsys >/dev/null 2>&1; then
  battery_status=$(dumpsys battery 2>/dev/null | awk '
    /AC powered:|USB powered:|Wireless powered:|Dock powered:/ && $NF=="true" {powered=1}
    END {print powered ? "Charging" : "Discharging"}')
fi
previous="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
if [ "${available:-0}" -lt "$MIN_AVAILABLE_MB" ] && [ "$battery_status" = "Discharging" ]; then
  write deferred "$target" "$previous" "preflight: battery=discharging available=${available}MB; retry_when_powered_or_memory_recovers"
  echo "$receipt"; exit 0
fi
if pgrep -f 'GradleDaemon|gradle-termux|tsc -p tsconfig' >/dev/null || [ "${available:-0}" -lt "$MIN_AVAILABLE_MB" ] \
   || awk -v l="$load" -v m="$MAX_LOAD" 'BEGIN{exit !(l>m)}'; then
  write refused "$target" "$previous" "preflight: battery=${battery_status:-unknown} available=${available}MB load=$load heavy_job=$(pgrep -fc 'GradleDaemon|gradle-termux|tsc -p tsconfig')"
  echo "$receipt"; exit 4
fi

cd "$REPO" || exit 5
previous="$(git rev-parse HEAD)"
git fetch -q "$REMOTE" "$BRANCH" >>"$log" 2>&1 || { write failed "$target" "$previous" "fetch_failed"; exit 5; }
full="$(git rev-parse --verify "$target^{commit}" 2>/dev/null)" || { write failed "$target" "$previous" "unknown_commit"; exit 5; }
git merge-base --is-ancestor "$full" "$REMOTE/$BRANCH" || { write refused "$full" "$previous" "commit_not_on_branch"; exit 5; }

# P1 (#182) : l'admission native retire l'autorité loopback de /v1/runs. L'APK qui signe les tours (#183) doit être
# installé AVANT ce Companion, sinon tous les tours de l'app deviennent non-owner jusqu'à l'installation et l'enrôlement.
# Précondition refus-seulement : confirmée une fois par Claude (marqueur) ou explicitement pour ce déploiement.
P1_FILE="openclaw-plugin-mobile-ui/src/companion/ownerTurnAdmission.ts"
if git cat-file -e "$full:$P1_FILE" 2>/dev/null && ! git cat-file -e "$previous:$P1_FILE" 2>/dev/null \
   && [ ! -f "$STATE/p1-app-admission-installed" ] && [ "${COMPANION_DEPLOY_P1_APP_READY:-}" != "1" ]; then
  write refused "$full" "$previous" "p1_app_admission_not_installed"; echo "$receipt"; exit 5
fi

# Content hash of a dist tree (paths and bytes), recorded at backup time to prove a rollback restored it.
dist_hash(){ [ -d "$1" ] || return 1
  ( cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) | sha256sum | cut -d' ' -f1; }
backup="$BACKUPS/companion-${previous:0:7}-$stamp"; mkdir -p "$backup" && cp -a "$PLUGIN/dist" "$backup/" \
  && backup_hash="$(dist_hash "$backup/dist")" && [ -n "$backup_hash" ] || { write failed "$full" "$previous" "backup_failed"; exit 5; }
# Bounded backups: keep the newest KEEP_BACKUPS Companion dist copies.
ls -dt "$BACKUPS"/companion-* 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -rf

# Every runtime copy follows the checkout (S24 12/10: the WhatsApp Gateway ran an 11/10 plugin for a day).
# A checkout older than runtime-sync.sh has nothing to bring along.
sync_runtime(){ [ -x "$ROOT/runtime-sync.sh" ] || { echo '{"ok":true,"skipped":"runtime_sync_absent"}'; return 0; }
  "$ROOT/runtime-sync.sh" "$1" 2>>"$log"; }

rollback(){
  reason="$1"; acc="${2:-}"
  # A candidate can install a model profile consumer before its Tier0 release is promoted.
  # Undo its exact set while this checkout still owns the manifest; the previous release may not.
  if [ -f "$ROOT/openclaw-compat/model-flow-selection.json" ] &&
     { ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/model-flow-selection.json" 2>/dev/null ||
       [ "$(git rev-parse "$previous:installer/termux-lite/openclaw-compat/model-flow-selection.json" 2>/dev/null)" != "$(git hash-object "$ROOT/openclaw-compat/model-flow-selection.json")" ]; }; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --patch-set model-flow-selection --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "model_flow_selection_rollback_failed"; exit 6; }
  fi
  # A candidate can extend a known patch set. Undo its exact manifest before the previous checkout
  # reapplies its own version; the old owner must never see an unknown newer patched hash.
  if [ -f "$ROOT/openclaw-compat/native-turn-provenance.json" ] &&
     { ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/native-turn-provenance.json" 2>/dev/null ||
       [ "$(git rev-parse "$previous:installer/termux-lite/openclaw-compat/native-turn-provenance.json" 2>/dev/null)" != "$(git hash-object "$ROOT/openclaw-compat/native-turn-provenance.json")" ]; }; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --patch-set native-turn-provenance --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "native_turn_provenance_rollback_failed"; exit 6; }
  fi
  # The memory recall keep-alive set: undo a manifest the previous checkout does not own byte for byte.
  if [ -f "$ROOT/openclaw-compat/memory-retrieval-warm.json" ] &&
     { ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/memory-retrieval-warm.json" 2>/dev/null ||
       [ "$(git rev-parse "$previous:installer/termux-lite/openclaw-compat/memory-retrieval-warm.json" 2>/dev/null)" != "$(git hash-object "$ROOT/openclaw-compat/memory-retrieval-warm.json")" ]; }; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --patch-set memory-retrieval-warm --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "memory_retrieval_warm_rollback_failed"; exit 6; }
  fi
  # The Android filesystem set: undo a manifest the previous checkout does not own byte for byte.
  if [ -f "$ROOT/openclaw-compat/android-fs-compat.json" ] &&
     { ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/android-fs-compat.json" 2>/dev/null ||
       [ "$(git rev-parse "$previous:installer/termux-lite/openclaw-compat/android-fs-compat.json" 2>/dev/null)" != "$(git hash-object "$ROOT/openclaw-compat/android-fs-compat.json")" ]; }; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --patch-set android-fs-compat --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "android_fs_compat_rollback_failed"; exit 6; }
  fi
  # The startup triage opt-out set: undo a manifest the previous checkout does not own byte for byte.
  if [ -f "$ROOT/openclaw-compat/startup-triage-optout.json" ] &&
     { ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/startup-triage-optout.json" 2>/dev/null ||
       [ "$(git rev-parse "$previous:installer/termux-lite/openclaw-compat/startup-triage-optout.json" 2>/dev/null)" != "$(git hash-object "$ROOT/openclaw-compat/startup-triage-optout.json")" ]; }; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --patch-set startup-triage-optout --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "startup_triage_optout_rollback_failed"; exit 6; }
  fi
  # The Codex Android set: undo a manifest the previous checkout does not own byte for byte.
  if [ -f "$ROOT/openclaw-compat/codex-android-compat.json" ] &&
     { ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/codex-android-compat.json" 2>/dev/null ||
       [ "$(git rev-parse "$previous:installer/termux-lite/openclaw-compat/codex-android-compat.json" 2>/dev/null)" != "$(git hash-object "$ROOT/openclaw-compat/codex-android-compat.json")" ]; }; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --patch-set codex-android-compat --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "codex_android_compat_rollback_failed"; exit 6; }
  fi
  if [ -f "$ROOT/openclaw-compat/agent-exec-auth-scope.json" ] &&
     ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/agent-exec-auth-scope.json" 2>/dev/null; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --patch-set agent-exec-auth-scope --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "agent_exec_auth_scope_rollback_failed"; exit 6; }
  fi
  # Undo this compatibility patch before returning to a revision that does not own it.
  if [ -f "$ROOT/openclaw-compat/whatsapp-network-recovery.py" ] &&
     ! git cat-file -e "$previous:installer/termux-lite/openclaw-compat/whatsapp-network-recovery.py" 2>/dev/null; then
    python3 "$ROOT/openclaw-compat/whatsapp-network-recovery.py" --rollback >>"$log" 2>&1 ||
      { write rollback_failed "$full" "$previous" "whatsapp_patch_rollback_failed"; exit 6; }
  fi
  git reset -q --hard "$previous" >>"$log" 2>&1 && rm -rf "$PLUGIN/dist" && cp -a "$backup/dist" "$PLUGIN/dist"
  # R03 (doc 52, 1.1): the rollback is judged on identity and availability, not on the full performance
  # acceptance. Under load a slow read or a transient 503 right after the restart wrote rollback_failed and
  # sent a false "rollback not healthy" alert. Checked: checkout HEAD is previous, the restored dist has the
  # hash recorded at backup time, /v1/health answers (bounded retry, 60 x 2 s).
  # restart() already performs the bounded /v1/health retry. Do not probe a second time: a
  # second probe would extend the rollback budget and make the receipt describe a check
  # different from the one that admitted the restarted Companion.
  health_ok=false; restart && health_ok=true
  head_now="$(git rev-parse HEAD 2>/dev/null)"; dist_now="$(dist_hash "$PLUGIN/dist" 2>/dev/null)"
  # S24 02/11 09:44 UTC (deploy 20e36415): the Companion health was not ready in time, the runtime sync sat at the
  # end of the && chain and never ran, so the Gateway kept the failed candidate's plugin (typed tools refused) for
  # 50 minutes. Once the checkout identity is proven, the Gateway plugin and Tier0 release are always brought back
  # to previous, whatever the Companion health; a failed sync is its own failed check.
  runtime_ok=false; runtime=""
  if [ "$head_now" = "$previous" ] && [ -n "$dist_now" ] && [ "$dist_now" = "$backup_hash" ]; then
    runtime=$(sync_runtime "$previous") && runtime_ok=true
  fi
  rollback_acc=$(python3 - "$previous" "$head_now" "$backup_hash" "$dist_now" "$health_ok" "$runtime_ok" <<'PY'
import json,sys
previous,head,want,got,health,runtime=sys.argv[1:7]
checks={"head_is_previous":bool(head) and head==previous,"dist_matches_backup":bool(got) and got==want,"health_ready":health=="true",
        "runtime_restored":runtime=="true"}
print(json.dumps({"ok":all(checks.values()),"criterion":"identity_and_health","head":head[:12] or None,"checks":checks}))
PY
)
  if [ "$head_now" = "$previous" ] && [ -n "$dist_now" ] && [ "$dist_now" = "$backup_hash" ] && $health_ok && $runtime_ok; then
    write rolled_back "$full" "$previous" "$reason" "$acc" "$runtime" "$rollback_acc"
  else write rollback_failed "$full" "$previous" "$reason" "$acc" "${runtime:-}" "$rollback_acc"; "$ROOT/incident-notify.sh" human_required "Samantha — déploiement Companion ${full:0:7} annulé mais le retour arrière n'est pas sain." >/dev/null 2>&1 || true; fi
  exit 6
}

[ -z "$(git status --porcelain --untracked-files=no)" ] || { write refused "$full" "$previous" "dirty_checkout"; exit 5; }
# Fast-forward only on the local deploy branch: a non-descendant target is refused, never forced.
git merge -q --ff-only "$full" >>"$log" 2>&1 || { write refused "$full" "$previous" "not_fast_forward"; exit 5; }
( cd "$PLUGIN" && nice -n 10 npm run build ) >>"$log" 2>&1 || rollback build_failed
restart || rollback health_failed
acc=$(accept 2>>"$log"); rc=$?
[ "$rc" -eq 0 ] || rollback acceptance_failed "$acc"
runtime=$(sync_runtime "$full") || rollback runtime_sync_failed "$acc"
# Amine 29/10: five representative paths on the switched runtime (Gateway on the synced plugin). A failed path
# rolls back; a provider outage (exit 3) does not, a rollback would not fix it. The section goes in the receipt.
if [ -f "$ROOT/deploy-parcours.py" ]; then
  gateway_ready || echo "settle: gateway_not_ready_before_parcours" >>"$log"
  # The paths judge the warm runtime Amine meets; the Gateway's one cold turn is paid here (brain-warm.py).
  [ -f "$ROOT/brain-warm.py" ] && { python3 "$ROOT/brain-warm.py" >>"$log" 2>&1 || echo "settle: brain_warm_failed" >>"$log"; }
  PARCOURS_JSON=$(python3 "$ROOT/deploy-parcours.py" 2>>"$log"); prc=$?; export PARCOURS_JSON
  [ "$prc" -eq 1 ] && rollback parcours_failed "$acc"
fi
write deployed "$full" "$previous" "ok" "$acc" "$runtime"
# M3 « une seule mémoire » : the receipt above (~/.openclaw/deploys/companion-*.json, served by
# deploymentReceipts.ts) is the canonical deploy record; no "Companion déployé" copy in memory.db.
echo "$receipt"
