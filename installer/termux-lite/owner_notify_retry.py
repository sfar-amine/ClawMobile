#!/data/data/com.termux/files/usr/bin/python3
"""Bounded retry policy for owner WhatsApp notifications.

Owner: ``whatsapp-owner-send.sh``. The ledger is the existing
``~/.openclaw/health/whatsapp-outbound.log`` written by that script; this module
adds no store, scheduler or daemon. One line per send attempt:

    <iso> state=failed reason=gateway_call rc=1 elapsed_s=4 key=<key>
    <iso> state=accepted elapsed_s=4 key=<key> message_id=<id>
    <iso> state=undeliverable attempts=<n> first_failed=<iso> key=<key>

S24 02/11/2026: 2138 failed lines for 26 keys, one key retried 979 times every
~5 min, and the Gateway accepted the same idempotency key again days later
(152 acceptances, 103 distinct message ids). Rules per key, read from the ledger:

* accepted once  -> never sent again (the Gateway key only dedupes briefly);
* undeliverable  -> terminal, never sent again;
* n failures     -> next attempt not before last failure + min(60 * 2**(n-1), 1800) s;
* n >= 12 failures, or first failure older than 24 h -> one ``undeliverable``
  line is appended and nothing more is sent.

No message body, recipient or Gateway error text is ever read or written here.
"""
import datetime as dt
import os
import re
import sys
import time
from pathlib import Path

BASE_DELAY_S = 60
MAX_DELAY_S = 1800
MAX_ATTEMPTS = 12
MAX_AGE_S = 86400
VISIBILITY_WINDOW_S = 86400
KEY_RE = re.compile(r'[A-Za-z0-9._:-]{1,200}')
STATE_RE = re.compile(r'(?:^|\s)state=([a-z_]+)(?:\s|$)')
KEY_FIELD_RE = re.compile(r'(?:^|\s)key=(\S+)(?:\s|$)')
MID_RE = re.compile(r'(?:^|\s)message_id=(\S+)(?:\s|$)')


def backoff_s(failures):
    """Delay after the n-th consecutive failure: 1, 2, 4, 8, 16, then 30 min."""
    if failures < 1:
        return 0
    return min(MAX_DELAY_S, BASE_DELAY_S * 2 ** min(failures - 1, 16))


def _epoch(stamp):
    try:
        value = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        return None
    if value.tzinfo is None:
        return None
    return value.timestamp()


def parse_line(line):
    """Closed projection of one ledger line: (epoch, state, key, message_id) or None."""
    parts = line.split(' ', 1)
    if len(parts) != 2:
        return None
    when = _epoch(parts[0])
    state = STATE_RE.search(' ' + parts[1])
    key = KEY_FIELD_RE.search(' ' + parts[1])
    if when is None or not state or not key:
        return None
    mid = MID_RE.search(' ' + parts[1])
    return when, state.group(1), key.group(1), mid.group(1) if mid else None


def entries_for(lines, key):
    return [row for row in map(parse_line, lines) if row and row[2] == key]


def read_lines(path):
    try:
        return Path(path).read_text(encoding='utf-8', errors='replace').splitlines()
    except FileNotFoundError:
        return []


def decide(entries, now):
    """Return (action, detail) for one key; action is send/accepted/undeliverable/deferred/exhausted."""
    accepted = [row for row in entries if row[1] == 'accepted']
    if accepted:
        return 'accepted', accepted[-1][3] or ''
    if any(row[1] == 'undeliverable' for row in entries):
        return 'undeliverable', ''
    failures = [row for row in entries if row[1] == 'failed']
    if not failures:
        return 'send', ''
    first = min(row[0] for row in failures)
    last = max(row[0] for row in failures)
    if len(failures) >= MAX_ATTEMPTS or now - first >= MAX_AGE_S:
        return 'exhausted', {'attempts': len(failures), 'first_failed': first}
    next_at = last + backoff_s(len(failures))
    if now < next_at:
        return 'deferred', int(next_at + 0.999)
    return 'send', ''


def _iso(epoch):
    return dt.datetime.fromtimestamp(epoch).astimezone().isoformat(timespec='seconds')


def record_undeliverable(path, key, detail, now):
    line = '%s state=undeliverable attempts=%d first_failed=%s key=%s\n' % (
        _iso(now), detail['attempts'], _iso(detail['first_failed']), key)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)


def gate(path, key, now=None):
    """Before a send. Records the terminal line once when the budget is exhausted."""
    now = time.time() if now is None else now
    action, detail = decide(entries_for(read_lines(path), key), now)
    if action == 'exhausted':
        record_undeliverable(path, key, detail, now)
        return 'undeliverable recorded'
    if action == 'accepted':
        return 'accepted ' + detail if detail else 'accepted'
    if action == 'deferred':
        return 'deferred %d' % detail
    return action


def after_failure(path, key, now=None):
    """After a failed attempt was appended: terminal now, or when the next attempt is due."""
    now = time.time() if now is None else now
    action, detail = decide(entries_for(read_lines(path), key), now)
    if action == 'exhausted':
        record_undeliverable(path, key, detail, now)
        return 'state=undeliverable'
    if action == 'undeliverable':
        return 'state=undeliverable'
    if action == 'deferred':
        return 'next_attempt_at=%d' % detail
    return 'next_attempt_at=%d' % int(now)


def recent_undeliverable(lines, now, window_s=VISIBILITY_WINDOW_S):
    """Keys that became undeliverable in the window, oldest first (for the health verdict)."""
    rows = [row for row in map(parse_line, lines) if row and row[1] == 'undeliverable' and 0 <= now - row[0] <= window_s]
    seen = []
    for row in sorted(rows):
        if row[2] not in seen:
            seen.append(row[2])
    return seen


def main(argv):
    if len(argv) != 4 or argv[1] not in ('gate', 'after-failure') or not KEY_RE.fullmatch(argv[3]):
        print('usage: owner_notify_retry.py gate|after-failure <ledger> <key>', file=sys.stderr)
        return 64
    print((gate if argv[1] == 'gate' else after_failure)(argv[2], argv[3]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
