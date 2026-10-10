#!/data/data/com.termux/files/usr/bin/bash
# Safe Companion deploy on the S24: preflight (one heavy job at a time, memory headroom), backup, build,
# restart, acceptance (companion-acceptance.py), automatic rollback on regression, receipt.
# Runs detached: restarting the Companion drops the Claw link, so the caller polls the receipt file.
#   companion-deploy.sh <commit>        deploy that commit of samantha-private/runtime/samantha-companion-private
#   companion-deploy.sh --status        print the last receipt
set -uo pipefail
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
REPO="$(CDPATH= cd -- "$ROOT/../.." && pwd)"
PLUGIN="$REPO/openclaw-plugin-mobile-ui"
# The acceptance check ships next to this script (works from a copy before the checkout carries it).
ACCEPT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/companion-acceptance.py"
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
try: acc=json.loads(sys.argv[6]) if len(sys.argv)>6 and sys.argv[6] else None
except ValueError: acc=None
json.dump({"version":1,"state":state,"target":target,"previous":previous,"detail":detail,"acceptance":acc,
           "at":datetime.datetime.now(datetime.timezone.utc).isoformat()},open(path,"w"),ensure_ascii=False)
PY
}
health(){ for _ in $(seq 1 60); do curl -fsS -m 3 http://127.0.0.1:8765/v1/health >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
restart(){ pkill -f 'dist/companion/server.js' 2>/dev/null; sleep 3; pgrep -f 'dist/companion/server.js' >/dev/null || nohup "$ROOT/companion-server.sh" >>"$log" 2>&1 </dev/null & health; }

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

backup="$BACKUPS/companion-${previous:0:7}-$stamp"; mkdir -p "$backup" && cp -a "$PLUGIN/dist" "$backup/" || { write failed "$full" "$previous" "backup_failed"; exit 5; }
# Bounded backups: keep the newest KEEP_BACKUPS Companion dist copies.
ls -dt "$BACKUPS"/companion-* 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -rf

rollback(){
  reason="$1"; acc="${2:-}"
  git reset -q --hard "$previous" >>"$log" 2>&1 && rm -rf "$PLUGIN/dist" && cp -a "$backup/dist" "$PLUGIN/dist"
  if restart && after=$(python3 "$ACCEPT" 2>>"$log"); then write rolled_back "$full" "$previous" "$reason" "$acc"
  else write rollback_failed "$full" "$previous" "$reason" "$acc"; "$ROOT/incident-notify.sh" human_required "Samantha — déploiement Companion ${full:0:7} annulé mais le retour arrière n'est pas sain." >/dev/null 2>&1 || true; fi
  exit 6
}

[ -z "$(git status --porcelain --untracked-files=no)" ] || { write refused "$full" "$previous" "dirty_checkout"; exit 5; }
# Fast-forward only on the local deploy branch: a non-descendant target is refused, never forced.
git merge -q --ff-only "$full" >>"$log" 2>&1 || { write refused "$full" "$previous" "not_fast_forward"; exit 5; }
( cd "$PLUGIN" && nice -n 10 npm run build ) >>"$log" 2>&1 || rollback build_failed
restart || rollback health_failed
acc=$(python3 "$ACCEPT" 2>>"$log"); rc=$?
[ "$rc" -eq 0 ] || rollback acceptance_failed "$acc"
write deployed "$full" "$previous" "ok" "$acc"
"$ROOT/context-event.sh" work completed_action "Companion déployé ${full:0:12} (précédent ${previous:0:12}), recette automatique acceptée." >/dev/null 2>&1 || true
echo "$receipt"
