#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"; D="$HOME/.openclaw/incidents"; Q="$D/queue"; LOG="$D/events.log"; mkdir -p "$Q"
exec 9>"$D/manager.lock"; flock -n 9 || exit 0; exec 9>&-
log(){ printf '%s id=%s %s\n' "$(date -Iseconds)" "$1" "$2" >>"$LOG"; }
process(){ dir="$1"; id=$(basename "$dir"); st=$(cat "$dir/status" 2>/dev/null||echo pending); [ "$st" = pending ] || return; kind=$(cat "$dir/kind"); msg=$(cat "$dir/message"); action=$(cat "$dir/action" 2>/dev/null||true); body="$msg"; if [ "$kind" = human_required ]; then body="$msg\n\nAction requise : $action"; fi;
  tries=$(cat "$dir/tries" 2>/dev/null||echo 0); now=$(date +%s); next=$(cat "$dir/next" 2>/dev/null||echo 0); [ "$now" -ge "$next" ] || return
  target=$(timeout 8 openclaw config get commands.ownerAllowFrom 2>/dev/null|grep -o 'whatsapp:[^" ]*'|head -1|cut -d: -f2-)
  if [ -n "$target" ] && timeout 20 openclaw message send --channel whatsapp --target "$target" --message "$body" >/dev/null 2>&1; then printf notified >"$dir/status"; printf whatsapp >"$dir/channel"; log "$id" "kind=$kind channel=whatsapp state=accepted"; return; fi
  tries=$((tries+1)); printf '%s' "$tries" >"$dir/tries"; log "$id" "kind=$kind channel=whatsapp state=failed attempt=$tries"
  if [ "$tries" -lt 3 ]; then printf '%s' $((now+tries*tries*10)) >"$dir/next"; return; fi
  if timeout 35 "$ROOT/incident-email.sh" "Samantha: intervention requise" "$body"; then printf notified >"$dir/status"; printf email >"$dir/channel"; log "$id" "kind=$kind channel=email state=accepted"; else printf '%s' $((now+300)) >"$dir/next"; log "$id" "kind=$kind channel=email state=failed retry_in_s=300"; fi
}
printf '%s component=incident-manager event=start state=ok\n' "$(date -Iseconds)" >>"$LOG"
while :; do for dir in "$Q"/*; do [ -d "$dir" ] && process "$dir"; done; sleep 10; done
