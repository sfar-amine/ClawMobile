#!/usr/bin/env python3
"""Check PR description headings without executing or printing the description."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re

WARNING_START = dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc)
ENFORCE_AT = WARNING_START + dt.timedelta(days=7)
MAX_EVENT_BYTES = 2 * 1024 * 1024
MAX_BODY_CHARS = 1024 * 1024
TEMPLATE = Path(__file__).resolve().parents[1] / '.github/pull_request_template.md'


def clock(value):
    try:
        now = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if now.tzinfo is None:
            raise ValueError()
        return now.astimezone(dt.timezone.utc)
    except ValueError as exc:
        raise argparse.ArgumentTypeError('now_requires_iso_timezone') from exc


def headings(text):
    # Ignore Markdown code fences and multiline comments; body is data only.
    text = re.sub(r'<!--.*?(?:-->|\Z)', '', text, flags=re.S)
    result, fence = [], None
    for line in text.splitlines():
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence) and not line[marker.end():].strip():
                fence = None
            continue
        if fence is None:
            heading = re.fullmatch(r' {0,3}## (.+?)\s*', line)
            if heading:
                result.append(heading.group(1))
    return result


def inspect(event, event_name, required):
    if event_name and event_name != 'pull_request':
        return 'skipped', [], None
    if not isinstance(event, dict):
        return 'invalid', [], 'invalid_event'
    if 'pull_request' not in event:
        return ('invalid', [], 'missing_pull_request') if event_name == 'pull_request' else ('skipped', [], None)
    pr = event['pull_request']
    if not isinstance(pr, dict):
        return 'invalid', [], 'invalid_pull_request'
    body = pr.get('body')
    if body is None:
        body = ''
    if not isinstance(body, str) or len(body) > MAX_BODY_CHARS:
        return 'invalid', [], 'invalid_body'
    actual = set(headings(body))
    missing = [heading for heading in required if heading not in actual]
    return ('missing' if missing else 'valid'), missing, None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event-path', default=os.environ.get('GITHUB_EVENT_PATH'))
    parser.add_argument('--event-name', default=os.environ.get('GITHUB_EVENT_NAME', ''))
    parser.add_argument('--now', type=clock, default=dt.datetime.now(dt.timezone.utc))
    args = parser.parse_args(argv)
    required = headings(TEMPLATE.read_text(encoding='utf-8'))
    if not required:
        print(json.dumps({'state': 'failed', 'reason': 'empty_template'}))
        return 1
    if args.event_name and args.event_name != 'pull_request':
        state, missing, reason = 'skipped', [], None
    elif not args.event_path:
        state, missing, reason = ('invalid', [], 'missing_event_path') if args.event_name == 'pull_request' else ('skipped', [], None)
    else:
        try:
            with open(args.event_path, 'rb') as handle:
                data = handle.read(MAX_EVENT_BYTES + 1)
            if len(data) > MAX_EVENT_BYTES:
                raise ValueError()
            event = json.loads(data)
            state, missing, reason = inspect(event, args.event_name, required)
        except (OSError, ValueError, UnicodeError):
            state, missing, reason = 'invalid', [], 'unreadable_or_invalid_event'
    blocking = args.now >= ENFORCE_AT
    failed = state in {'missing', 'invalid'}
    print(json.dumps({'state': 'failed' if failed and blocking else 'warning' if failed else state,
                      'missingSections': missing, 'reason': reason,
                      'enforceAt': ENFORCE_AT.isoformat().replace('+00:00', 'Z')}, ensure_ascii=False))
    if failed:
        print('::error::PR description does not satisfy the repository template.' if blocking else
              '::warning::PR description does not satisfy the repository template; grace period active.')
    return 1 if failed and blocking else 0

if __name__ == '__main__':
    raise SystemExit(main())
