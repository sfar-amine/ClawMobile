#!/data/data/com.termux/files/usr/bin/bash
set -u
CONF=${HOME}/.openclaw/secrets/incident-email.env
CACHE=${HOME}/.openclaw/health/smtp-probe.json
mode=send
if [ "${1:-}" = "--probe" ]; then mode=probe; shift; fi
[ -r "$CONF" ] || exit 78
set -a
. "$CONF"
set +a
: "${INCIDENT_EMAIL_TO:?}" "${INCIDENT_EMAIL_FROM:?}" "${INCIDENT_EMAIL_SMTP_URL:?}" "${INCIDENT_EMAIL_USER:?}" "${INCIDENT_EMAIL_PASSWORD:?}"
subject=${1:-Samantha incident}; shift || true
body="$*"
export INCIDENT_EMAIL_MODE="$mode" INCIDENT_EMAIL_SUBJECT="$subject" INCIDENT_EMAIL_BODY="$body"
python3 - <<'PY'
import os, smtplib, ssl, sys
from email.message import EmailMessage
from urllib.parse import urlparse
u=urlparse(os.environ['INCIDENT_EMAIL_SMTP_URL'])
host=u.hostname
if not host or u.scheme not in ('smtp','smtps'):
    raise SystemExit(78)
port=u.port or (465 if u.scheme=='smtps' else 587)
ctx=ssl.create_default_context()
try:
    if u.scheme=='smtps':
        server=smtplib.SMTP_SSL(host,port,timeout=20,context=ctx)
    else:
        server=smtplib.SMTP(host,port,timeout=20)
        server.ehlo()
        server.starttls(context=ctx)
        server.ehlo()
    with server:
        server.login(os.environ['INCIDENT_EMAIL_USER'],os.environ['INCIDENT_EMAIL_PASSWORD'])
        code,_=server.noop()
        if code >= 400:
            raise RuntimeError('smtp_noop_failed')
        if os.environ['INCIDENT_EMAIL_MODE']=='send':
            msg=EmailMessage()
            msg['From']=os.environ['INCIDENT_EMAIL_FROM']
            msg['To']=os.environ['INCIDENT_EMAIL_TO']
            msg['Subject']=os.environ['INCIDENT_EMAIL_SUBJECT']
            msg.set_content(os.environ['INCIDENT_EMAIL_BODY'])
            server.send_message(msg)
except Exception as exc:
    sys.stderr.write('incident-email transport failed: '+type(exc).__name__+'\n')
    raise SystemExit(1)
PY
rc=$?
mkdir -p "$(dirname "$CACHE")"
python3 - "$CACHE" "$rc" <<'PY'
import json,os,sys,time
from pathlib import Path
p=Path(sys.argv[1]); rc=int(sys.argv[2])
row={'checked_at':time.time(),'state':'ready' if rc==0 else 'down','reason':'probe_ok' if rc==0 else 'probe_failed'}
tmp=p.with_suffix('.tmp'); tmp.write_text(json.dumps(row,sort_keys=True)+'\n'); os.replace(tmp,p)
PY
exit "$rc"
