#!/data/data/com.termux/files/usr/bin/bash
set -u
STATE=${HOME}/.openclaw/incidents
mkdir -p "$STATE"
kind=${1:-info}; shift || true
msg="$*"
id=$(printf "%s" "$kind:$msg" | sha256sum | cut -c1-16)
log="$STATE/events.log"
printf "%s id=%s kind=%s state=detected\n" "$(date -Iseconds)" "$id" "$kind" >>"$log"
target=$(openclaw config get commands.ownerAllowFrom 2>/dev/null | grep -o 'whatsapp:[^" ]*' | head -1 | cut -d: -f2-)
for n in 1 2 3; do
  if [ -n "$target" ] && timeout 20 openclaw message send --channel whatsapp --target "$target" --message "$msg" >/dev/null 2>&1; then
    printf "%s id=%s channel=whatsapp state=accepted attempt=%s\n" "$(date -Iseconds)" "$id" "$n" >>"$log"
    exit 0
  fi
  printf "%s id=%s channel=whatsapp state=failed attempt=%s\n" "$(date -Iseconds)" "$id" "$n" >>"$log"
  sleep $((n*n*2))
done
if "$HOME/ClawMobile/installer/termux-lite/incident-email.sh" "Samantha: intervention requise" "$msg"; then
  printf "%s id=%s channel=email state=accepted\n" "$(date -Iseconds)" "$id" >>"$log"
  exit 0
fi
printf "%s id=%s channel=email state=failed\n" "$(date -Iseconds)" "$id" >>"$log"
exit 75
