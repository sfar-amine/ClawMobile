#!/data/data/com.termux/files/usr/bin/bash
set -u
D="$HOME/.openclaw/incidents"; Q="$D/queue"; mkdir -p "$Q"
kind=${1:-info}; shift || true
msg=${1:-}; shift || true
action="$*"
[ -n "$msg" ] || exit 64
if [ "$kind" = human_required ] && [ -z "$action" ]; then exit 65; fi
id=$(printf '%s' "$kind:$msg:$action"|sha256sum|cut -c1-16); dir="$Q/$id"; mkdir -p "$dir"
printf '%s' "$kind" >"$dir/kind"; printf '%s' "$msg" >"$dir/message"; printf '%s' "$action" >"$dir/action"
case "$kind" in info|human_required) rm -f "$dir/component";; *) printf '%s' "$kind" >"$dir/component";; esac
[ -e "$dir/created" ] || date -Iseconds >"$dir/created"
status=$(cat "$dir/status" 2>/dev/null || echo new)
# The id already covers kind, message and action. Never duplicate a queued
# delivery. RDC and context-guardian alerts also remain quiet after delivery
# until their exact component is closed; a later recurrence starts a new cycle.
case "$status:$kind" in
  pending:*) exit 0;;
  notified:remote_desktop|notified:context_guardian) exit 0;;
  notified:*) printf 0 >"$dir/tries"; printf 0 >"$dir/next";;
  closed:remote_desktop|closed:context_guardian) printf 0 >"$dir/tries"; printf 0 >"$dir/next";;
  closed:*) exit 0;;
esac
printf pending >"$dir/status"; printf '%s id=%s kind=%s event=queued state=pending\n' "$(date -Iseconds)" "$id" "$kind" >>"$D/events.log"
