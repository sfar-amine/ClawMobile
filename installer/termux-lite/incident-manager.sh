#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"; D="$HOME/.openclaw/incidents"; Q="$D/queue"; LOG="$D/events.log"; mkdir -p "$Q"
exec 9>"$D/manager.lock"; flock -n 9 || exit 0
log(){ printf '%s id=%s %s\n' "$(date -Iseconds)" "$1" "$2" >>"$LOG"; }
# Retry budget is owned by whatsapp-owner-send.sh (owner_notify_retry.py): it
# answers 75 while its backoff runs and 76 once the key is undeliverable. The
# manager keeps a hard cap of its own so a missing policy can never loop again
# (S24 30/10: one key retried 979 times, every 5 min, WhatsApp + email).
MAX_TRIES=12
# A re-opened RDC/context cycle (incident-notify.sh) gets its own key: an
# accepted key is never sent twice.
notify_key(){ c=$(cat "$1/cycle" 2>/dev/null||echo 0); case "$c" in ''|*[!0-9]*|0) printf 'incident-%s' "$2";; *) printf 'incident-%s-c%s' "$2" "$c";; esac; }
undeliverable(){ printf undeliverable >"$1/status"; date -Iseconds >"$1/undeliverable"; log "$2" "kind=$3 channel=whatsapp state=undeliverable attempts=$4"; }
email(){ timeout 35 "$ROOT/incident-email.sh" "Samantha: intervention requise" "$2" && { printf notified >"$1/status"; printf email >"$1/channel"; log "$3" "kind=$4 channel=email state=accepted"; }; }
process(){ dir="$1"; id=$(basename "$dir"); st=$(cat "$dir/status" 2>/dev/null||echo pending); [ "$st" = pending ] || return; kind=$(cat "$dir/kind"); msg=$(cat "$dir/message"); action=$(cat "$dir/action" 2>/dev/null||true); body="$msg"; if [ "$kind" = human_required ]; then body="$msg\n\nÀ faire sur le S24 :\n$action\n\nEnsuite : aucune autre action. Samantha détectera le prérequis, reprendra automatiquement le traitement et confirmera la récupération."; fi;
  tries=$(cat "$dir/tries" 2>/dev/null||echo 0); case "$tries" in ''|*[!0-9]*) tries=0;; esac; now=$(date +%s); next=$(cat "$dir/next" 2>/dev/null||echo 0); case "$next" in ''|*[!0-9]*) next=0;; esac; [ "$now" -ge "$next" ] || return
  key=$(notify_key "$dir" "$id")
  out=$(timeout 18 "$ROOT/whatsapp-owner-send.sh" "$body" "$key" 2>/dev/null); rc=$?
  if [ "$rc" -eq 0 ]; then printf notified >"$dir/status"; printf whatsapp >"$dir/channel"; log "$id" "kind=$kind channel=whatsapp state=accepted"; return; fi
  due=$(printf '%s\n' "$out" | sed -n 's/^next_attempt_at=\([0-9][0-9]*\)$/\1/p' | tail -n1)
  if [ "$rc" -eq 75 ]; then printf '%s' "${due:-$((now+60))}" >"$dir/next"; return; fi
  if [ "$rc" -ne 76 ]; then tries=$((tries+1)); printf '%s' "$tries" >"$dir/tries"; log "$id" "kind=$kind channel=whatsapp state=failed attempt=$tries"; fi
  terminal=0; { [ "$rc" -eq 76 ] || printf '%s\n' "$out" | grep -qx 'state=undeliverable' || [ "$tries" -ge "$MAX_TRIES" ]; } && terminal=1
  if [ "$terminal" -eq 0 ] && [ "$tries" -lt 3 ]; then printf '%s' "${due:-$((now+tries*tries*10))}" >"$dir/next"; return; fi
  # Email fallback only after a real WhatsApp attempt (or once at the terminal
  # state), so it is bounded by the same budget.
  if email "$dir" "$body" "$id" "$kind"; then return; fi
  if [ "$terminal" -eq 1 ]; then undeliverable "$dir" "$id" "$kind" "$tries"; return; fi
  due=${due:-$((now+300))}; printf '%s' "$due" >"$dir/next"; log "$id" "kind=$kind channel=email state=failed retry_in_s=$((due-now))"
}
printf '%s component=incident-manager event=start state=ok\n' "$(date -Iseconds)" >>"$LOG"
while :; do printf '%s' "$(date +%s)" >"$HOME/.openclaw/health/incident-manager.heartbeat"; for dir in "$Q"/*; do [ -d "$dir" ] && process "$dir"; done; [ "${CLAW_INCIDENT_MANAGER_ONCE:-0}" = 1 ] && exit 0; sleep 10; done
