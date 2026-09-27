#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="$HOME/ClawMobile/installer/termux-lite"
D="$HOME/.openclaw/autonomous-engineering"; LOG="$D/closure.log"; mkdir -p "$D"
state="${1:-}"; component="${2:-unknown}"; summary="${3:-Autonomous Engineering update}"
case "$state" in recovered|failed|human_required) ;; *) exit 64;; esac
case "$component" in *[!A-Za-z0-9._-]*) exit 64;; esac
etype=checkpoint; [ "$state" = recovered ] && etype=completed_action; [ "$state" = human_required ] && etype=open_thread
"$ROOT/context-event.sh" openclaw "$etype" "Autonomous Engineering: component=$component state=$state summary=$summary" >/dev/null 2>&1 || true
target=$(timeout 8 openclaw config get commands.ownerAllowFrom 2>/dev/null|grep -o 'whatsapp:[^" ]*'|head -1|cut -d: -f2-)
wa=failed; mail=failed
if [ -n "$target" ] && timeout 25 openclaw message send --channel whatsapp --target "$target" --message "Samantha — $component : $summary (état: $state)." >/dev/null 2>&1; then wa=accepted; fi
if timeout 35 "$ROOT/incident-email.sh" "Samantha — Autonomous Engineering: $component" "$summary (état: $state)." >/dev/null 2>&1; then mail=accepted; fi
printf '%s component=%s state=%s whatsapp=%s email=%s\n' "$(date -Iseconds)" "$component" "$state" "$wa" "$mail" >>"$LOG"
[ "$wa" = accepted ] || [ "$mail" = accepted ]
