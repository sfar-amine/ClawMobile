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
[ -e "$dir/created" ] || date -Iseconds >"$dir/created"
status=$(cat "$dir/status" 2>/dev/null || echo pending); case "$status" in closed) exit 0;; notified) printf pending >"$dir/status"; printf 0 >"$dir/tries"; printf 0 >"$dir/next";; esac
printf pending >"$dir/status"; printf '%s id=%s kind=%s event=queued state=pending\n' "$(date -Iseconds)" "$id" "$kind" >>"$D/events.log"
