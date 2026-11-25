#!/data/data/com.termux/files/usr/bin/bash
# The owner WhatsApp/email body must carry real line breaks, never a literal "\n".
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill "${pid:-}" 2>/dev/null || true; rm -rf "$T"' EXIT
mkdir -p "$T/root" "$T/home/.openclaw/health" "$T/home/.openclaw/incidents/queue/x1"
cat >"$T/root/whatsapp-owner-send.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s' "$1" >"$HOME/sent-body"; printf 'mid\n'
STUB
chmod +x "$T/root/whatsapp-owner-send.sh"
q="$T/home/.openclaw/incidents/queue/x1"
printf human_required >"$q/kind"; printf pending >"$q/status"
printf '%s' 'Samantha — batterie du S24 très faible : 6 %.' >"$q/message"
printf '%s' '1. Branche le S24.\n2. Attends.' >"$q/action"
HOME="$T/home" CLAW_RUNTIME_ROOT="$T/root" bash "$R/incident-manager.sh" & pid=$!
for _ in $(seq 1 50); do [ -s "$T/home/sent-body" ] && break; sleep 0.1; done
body="$(cat "$T/home/sent-body")"
expected="Samantha — batterie du S24 très faible : 6 %.

À faire sur le S24 :
1. Branche le S24.
2. Attends.

Ensuite : aucune autre action. Samantha détectera le prérequis, reprendra automatiquement le traitement et confirmera la récupération."
[ "$body" = "$expected" ] || { printf 'unexpected body:\n%s\n' "$body" >&2; exit 1; }
case "$body" in *'\n'*) echo 'literal \n in body' >&2; exit 1;; esac
test "$(cat "$q/status")" = notified
echo 'incident manager newlines: OK'
