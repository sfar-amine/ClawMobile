#!/data/data/com.termux/files/usr/bin/bash
set -u
CONF=${HOME}/.openclaw/secrets/incident-email.env
[ -r "$CONF" ] || exit 78
. "$CONF"
: "${INCIDENT_EMAIL_TO:?}" "${INCIDENT_EMAIL_FROM:?}" "${INCIDENT_EMAIL_SMTP_URL:?}" "${INCIDENT_EMAIL_USER:?}" "${INCIDENT_EMAIL_PASSWORD:?}"
subject=${1:-Samantha incident}; shift || true
body="$*"
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n' "$INCIDENT_EMAIL_FROM" "$INCIDENT_EMAIL_TO" "$subject" "$body" >"$tmp"
timeout 30 curl --fail --silent --show-error --url "$INCIDENT_EMAIL_SMTP_URL" --ssl-reqd --user "$INCIDENT_EMAIL_USER:$INCIDENT_EMAIL_PASSWORD" --mail-from "$INCIDENT_EMAIL_FROM" --mail-rcpt "$INCIDENT_EMAIL_TO" --upload-file "$tmp" >/dev/null
