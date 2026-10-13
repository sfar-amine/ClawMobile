#!/data/data/com.termux/files/usr/bin/bash
set -u
D="$HOME/.openclaw/incidents"; Q="$D/queue"; mkdir -p "$Q"
kind=${1:-info}; shift || true
msg=${1:-}; shift || true
action="$*"
[ -n "$msg" ] || exit 64
if [ "$kind" = human_required ] && [ -z "$action" ]; then exit 65; fi
id=$(printf '%s' "$kind:$msg:$action"|sha256sum|cut -c1-16); dir="$Q/$id"
exec 8>"$Q/.$id.lock"; flock 8
if [ -d "$dir" ]; then
 status=$(cat "$dir/status" 2>/dev/null || echo pending)
 case "$status" in pending|notified|closed) exit 0;; esac
fi
tmp="$Q/.$id.tmp.$$"; rm -rf "$tmp"; mkdir "$tmp"
printf '%s' "$kind" >"$tmp/kind"; printf '%s' "$msg" >"$tmp/message"; printf '%s' "$action" >"$tmp/action"
date -Iseconds >"$tmp/created"; printf pending >"$tmp/status"; mv "$tmp" "$dir"
printf '%s id=%s kind=%s event=queued state=pending\n' "$(date -Iseconds)" "$id" "$kind" >>"$D/events.log"
