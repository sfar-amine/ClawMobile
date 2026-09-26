#!/data/data/com.termux/files/usr/bin/bash
set -u
D="$HOME/.openclaw/incidents"; Q="$D/queue"; LOG="$D/events.log"
component="${1:-}"; message="${2:-Samantha — récupération vérifiée.}"
[ -n "$component" ] || exit 64
matched=0
for dir in "$Q"/*; do
  [ -d "$dir" ] || continue
  st="$(cat "$dir/status" 2>/dev/null || echo pending)"
  [ "$st" = closed ] && continue
  msg="$(cat "$dir/message" 2>/dev/null || true)"
  case "$msg" in *"$component"*) ;; *) continue;; esac
  id="$(basename "$dir")"; matched=1
  printf recovered >"$dir/status"
  printf '%s id=%s component=%s event=recovered state=verified\n' "$(date -Iseconds)" "$id" "$component" >>"$LOG"
  printf closed >"$dir/status"
  printf '%s' "$(date -Iseconds)" >"$dir/closed"
  printf '%s id=%s component=%s event=closed state=ok\n' "$(date -Iseconds)" "$id" "$component" >>"$LOG"
done
if [ "$matched" -eq 1 ]; then
  target=$(timeout 8 openclaw config get commands.ownerAllowFrom 2>/dev/null|grep -o 'whatsapp:[^" ]*'|head -1|cut -d: -f2-)
  if [ -n "$target" ] && timeout 20 openclaw message send --channel whatsapp --target "$target" --message "$message" >/dev/null 2>&1; then
    printf '%s component=%s recovery_channel=whatsapp state=accepted\n' "$(date -Iseconds)" "$component" >>"$LOG"
  elif timeout 35 "$HOME/ClawMobile/installer/termux-lite/incident-email.sh" "Samantha: récupération vérifiée" "$message"; then
    printf '%s component=%s recovery_channel=email state=accepted\n' "$(date -Iseconds)" "$component" >>"$LOG"
  else
    printf '%s component=%s recovery_channel=none state=failed\n' "$(date -Iseconds)" "$component" >>"$LOG"
  fi
fi
