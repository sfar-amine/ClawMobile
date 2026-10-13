#!/data/data/com.termux/files/usr/bin/bash
set -u
D="$HOME/.openclaw/incidents"; Q="$D/queue"; L="$D/locks"; mkdir -p "$Q" "$L"
kind=${1:-info}; shift || true
msg=${1:-}; shift || true
action="$*"
[ -n "$msg" ] || exit 64
if [ "$kind" = human_required ] && [ -z "$action" ]; then exit 65; fi
id=$(printf '%s' "$kind:$msg:$action"|sha256sum|cut -c1-16); dir="$Q/$id"
exec 8>"$L/$id.lock"; flock 8
status=new
[ -d "$dir" ] && status=$(cat "$dir/status" 2>/dev/null || echo new)
# The content hash is the alert identity. An active or delivered identical
# notification is never queued twice. RDC/context alerts may start a new cycle
# only after their exact component was closed by incident-close.sh.
case "$status:$kind" in
  pending:*|notified:*) exit 0;;
  closed:remote_desktop|closed:context_guardian)
    printf '%s' "$kind" >"$dir/kind"; printf '%s' "$msg" >"$dir/message"; printf '%s' "$action" >"$dir/action"
    printf '%s' "$kind" >"$dir/component"; printf 0 >"$dir/tries"; printf 0 >"$dir/next"; printf pending >"$dir/status"
    ;;
  closed:*) exit 0;;
  *)
    tmp="$Q/.$id.tmp.$$"; rm -rf "$tmp"; mkdir "$tmp"
    printf '%s' "$kind" >"$tmp/kind"; printf '%s' "$msg" >"$tmp/message"; printf '%s' "$action" >"$tmp/action"
    case "$kind" in info|human_required) :;; *) printf '%s' "$kind" >"$tmp/component";; esac
    date -Iseconds >"$tmp/created"; printf pending >"$tmp/status"; mv "$tmp" "$dir"
    ;;
esac
printf '%s id=%s kind=%s event=queued state=pending\n' "$(date -Iseconds)" "$id" "$kind" >>"$D/events.log"
