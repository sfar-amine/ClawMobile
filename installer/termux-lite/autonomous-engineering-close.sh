#!/data/data/com.termux/files/usr/bin/bash
set -u
ROOT="${CLAW_RUNTIME_ROOT:-$HOME/ClawMobile/installer/termux-lite}"
D="$HOME/.openclaw/autonomous-engineering"; LOG="$D/closure.log"; mkdir -p "$D"
state="${1:-}"; component="${2:-unknown}"; summary="${3:-Autonomous Engineering update}"
case "$state" in recovered|failed|human_required) ;; *) exit 64;; esac
case "$component" in *[!A-Za-z0-9._-]*) exit 64;; esac
etype=checkpoint; [ "$state" = recovered ] && etype=completed_action; [ "$state" = human_required ] && etype=open_thread
event_id="$("$ROOT/context-event.sh" openclaw "$etype" "Autonomous Engineering: component=$component state=$state summary=$summary" 2>/dev/null || true)"
wa=failed; mail=failed
if [ -n "$event_id" ]; then
  wa_key="ae-$event_id"
else
  wa_key="ae-$(printf '%s' "$state:$component:$summary" | sha256sum | cut -c1-48)"
fi
if timeout 18 "$ROOT/whatsapp-owner-send.sh" "Samantha — $component : $summary (état: $state)." "$wa_key" >/dev/null 2>&1; then wa=accepted; fi
if timeout 35 "$ROOT/incident-email.sh" "Samantha — Autonomous Engineering: $component" "$summary (état: $state)." >/dev/null 2>&1; then mail=accepted; fi
printf '%s component=%s state=%s whatsapp=%s email=%s\n' "$(date -Iseconds)" "$component" "$state" "$wa" "$mail" >>"$LOG"
[ "$wa" = accepted ] || [ "$mail" = accepted ]
