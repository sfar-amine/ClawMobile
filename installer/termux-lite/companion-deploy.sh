#!/data/data/com.termux/files/usr/bin/bash
# Safe Companion deploy on the S24: preflight (one heavy job at a time, memory headroom), backup, build,
# restart, acceptance (companion-acceptance.py), runtime copies brought to the same commit (runtime-sync.sh:
# Gateway plugin, Tier0 release, deploy tools), automatic rollback on regression (judged on identity and
# health, recorded in rollback_acceptance), receipt.
# Runs detached: restarting the Companion drops the Claw link, so the caller polls the receipt file.
#   companion-deploy.sh <commit>        deploy that commit of samantha-private/runtime/samantha-companion-private
#   COMPANION_DEPLOY_WAIT_CALM_S=1200   wait up to that long for a calm phone instead of refusing at once
#   companion-deploy.sh --status        print the last receipt
set -uo pipefail
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
REPO="$(CDPATH= cd -- "$ROOT/../.." && pwd)"
PLUGIN="$REPO/openclaw-plugin-mobile-ui"
# The acceptance check is the one carried by the checkout being judged (target after the fast-forward,
# previous after a rollback), so every lot's acceptance lines run. The copy next to this script is only
# a fallback for a checkout that does not carry it yet. A rollback is not judged by it (R03, see rollback()).
ACCEPT_FALLBACK="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/companion-acceptance.py"
accept(){ if [ -f "$ROOT/companion-acceptance.py" ]; then python3 "$ROOT/companion-acceptance.py"; else python3 "$ACCEPT_FALLBACK"; fi; }
STATE="$HOME/.openclaw/deploys"; BACKUPS="$HOME/.openclaw/backups"
REMOTE="${COMPANION_DEPLOY_REMOTE:-samantha-private}"; BRANCH="${COMPANION_DEPLOY_BRANCH:-runtime/samantha-companion-private}"
KEEP_BACKUPS="${COMPANION_DEPLOY_KEEP:-5}"; MIN_AVAILABLE_MB="${COMPANION_DEPLOY_MIN_MB:-1200}"; MAX_LOAD="${COMPANION_DEPLOY_MAX_LOAD:-7}"
mkdir -p "$STATE" "$BACKUPS"; chmod 700 "$STATE"

if [ "${1:-}" = "--status" ]; then ls -t "$STATE"/companion-*.json 2>/dev/null | head -1 | xargs -r cat; exit 0; fi
target="${1:-}"; [[ "$target" =~ ^[0-9a-f]{7,40}$ ]] || { echo "usage: $0 <commit>|--status" >&2; exit 2; }

exec 9>"$STATE/companion-deploy.lock"; flock -n 9 || { echo "deploy_already_running" >&2; exit 3; }
stamp="$(date +%Y%m%dT%H%M%S)"; receipt="$STATE/companion-$stamp.json"; log="$STATE/companion-$stamp.log"
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
json.dump(doc,open(path,"w"),ensure_ascii=False)
PY
  # Only ordinary logs are bounded. Canonical JSON receipts are never removed.
  python3 "$ROOT/bounded-log.py" "$log" || true
  python3 "$ROOT/bounded-log.py" "$STATE" --deployment-logs || true
}
health(){ for _ in $(seq 1 60); do curl -fsS -m 3 http://127.0.0.1:8765/v1/health >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
# The Companion is started with the lock fd closed: otherwise it inherits it and holds the deploy lock forever.
restart(){ pkill -f 'dist/companion/server.js' 2>/dev/null; sleep 3
  pgrep -f 'dist/companion/server.js' >/dev/null || { nohup "$ROOT/companion-server.sh" >>"$log" 2>&1 </dev/null & } 9>&-
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
# Gateway-backed reads answer again (not 503) before they are judged.
gateway_ready(){ for _ in $(seq 1 30); do code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8765/v1/control/health?contract=2 2>/dev/null); [ "$code" = 200 ] && return 0; sleep 4; done; return 1; }
WAIT_CALM_S="${COMPANION_DEPLOY_WAIT_CALM_S:-0}"
[ "$WAIT_CALM_S" -gt 0 ] && wait_calm "$WAIT_CALM_S" "$MAX_LOAD" >/dev/null 2>&1 || true

# Preflight: never stack a deploy on a heavy job (Gradle, another build) or on a phone short of memory.
available=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); # /proc/loadavg is denied to detached processes on Android: read the 1-minute load from uptime.
load=$(uptime 2>/dev/null | sed -n 's/.*load average: *\([0-9.]*\).*/\1/p'); load="${load:-0}"
if pgrep -f 'GradleDaemon|gradle-termux|tsc -p tsconfig' >/dev/null || [ "${available:-0}" -lt "$MIN_AVAILABLE_MB" ] \
   || awk -v l="$load" -v m="$MAX_LOAD" 'BEGIN{exit !(l>m)}'; then
  write refused "$target" "" "preflight: available=${available}MB load=$load heavy_job=$(pgrep -fc 'GradleDaemon|gradle-termux|tsc -p tsconfig')"
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
  rollback_acc=$(python3 - "$previous" "$head_now" "$backup_hash" "$dist_now" "$health_ok" <<'PY'
import json,sys
previous,head,want,got,health=sys.argv[1:6]
checks={"head_is_previous":bool(head) and head==previous,"dist_matches_backup":bool(got) and got==want,"health_ready":health=="true"}
print(json.dumps({"ok":all(checks.values()),"criterion":"identity_and_health","head":head[:12] or None,"checks":checks}))
PY
)
  if [ "$head_now" = "$previous" ] && [ -n "$dist_now" ] && [ "$dist_now" = "$backup_hash" ] && $health_ok \
     && runtime=$(sync_runtime "$previous"); then write rolled_back "$full" "$previous" "$reason" "$acc" "$runtime" "$rollback_acc"
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
write deployed "$full" "$previous" "ok" "$acc" "$runtime"
# M3 « une seule mémoire » : the receipt above (~/.openclaw/deploys/companion-*.json, served by
# deploymentReceipts.ts) is the canonical deploy record; no "Companion déployé" copy in memory.db.
echo "$receipt"
