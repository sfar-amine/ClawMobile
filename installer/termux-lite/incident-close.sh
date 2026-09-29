#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"
D="$HOME/.openclaw/incidents"; Q="$D/queue"; LOG="$D/events.log"
component="${1:-}"; message="${2:-Samantha — récupération vérifiée.}"
[ -n "$component" ] || exit 64
matched=0
last_id=""
for dir in "$Q"/*; do
  [ -d "$dir" ] || continue
  st="$(cat "$dir/status" 2>/dev/null || echo pending)"
  [ "$st" = closed ] && continue
  msg="$(cat "$dir/message" 2>/dev/null || true)"
  case "$msg" in *"$component"*) ;; *) continue;; esac
  id="$(basename "$dir")"; matched=1; last_id="$id"
  printf recovered >"$dir/status"
  printf '%s id=%s component=%s event=recovered state=verified\n' "$(date -Iseconds)" "$id" "$component" >>"$LOG"
  printf closed >"$dir/status"
  printf '%s' "$(date -Iseconds)" >"$dir/closed"
  printf '%s id=%s component=%s event=closed state=ok\n' "$(date -Iseconds)" "$id" "$component" >>"$LOG"
done
if [ "$matched" -eq 1 ]; then
  recovery_key="recovery-$(printf '%s' "$component:$last_id" | sha256sum | cut -c1-24)"
  if timeout 18 "$ROOT/whatsapp-owner-send.sh" "$message" "$recovery_key" >/dev/null 2>&1; then
    printf '%s component=%s recovery_channel=whatsapp state=accepted\n' "$(date -Iseconds)" "$component" >>"$LOG"
  elif timeout 35 "$ROOT/incident-email.sh" "Samantha: récupération vérifiée" "$message"; then
    printf '%s component=%s recovery_channel=email state=accepted\n' "$(date -Iseconds)" "$component" >>"$LOG"
  else
    printf '%s component=%s recovery_channel=none state=failed\n' "$(date -Iseconds)" "$component" >>"$LOG"
  fi
fi
