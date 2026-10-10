#!/usr/bin/env python3
"""Read-only route qualification report. Never modifies qualifiedRoutes."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

MAX_EVIDENCE_BYTES = 8 * 1024 * 1024


def report(value):
    if not isinstance(value, dict) or value.get('schema') != 'samantha.voice.route-evidence.v1':
        raise ValueError('invalid_route_evidence')
    fingerprint, route = value.get('deviceFingerprint'), value.get('routeKey')
    if not all(isinstance(x, str) and re.fullmatch(r'[A-Za-z0-9._:/|+ -]{1,512}', x) for x in (fingerprint, route)):
        raise ValueError('invalid_route_identity')
    rows = value.get('samples', [])
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError('invalid_samples')
    good, missed, false, incomplete = [], 0, 0, 0
    for sample in rows:
        if not isinstance(sample, dict):
            raise ValueError('invalid_sample')
        if sample.get('fingerprint') != fingerprint or sample.get('routeKey') != route:
            raise ValueError('mixed_route_or_build')
        if sample.get('externalAligned') is not True:
            incomplete += 1
            continue
        kind = sample.get('kind')
        if kind == 'interruption':
            latency = sample.get('cutMs')
            if sample.get('detected') is not True or sample.get('stopped') is not True:
                missed += 1
            elif type(latency) not in (int, float) or latency < 0 or (type(latency) is float and not math.isfinite(latency)):
                incomplete += 1
            else:
                good.append(latency)
        elif kind == 'negative':
            if type(sample.get('interrupted')) is not bool:
                incomplete += 1
            elif sample['interrupted']:
                false += 1
        else:
            incomplete += 1
    negatives = sum(s.get('kind') == 'negative' and s.get('externalAligned') is True and
                    type(s.get('interrupted')) is bool for s in rows)
    observed = len(good) + missed
    complete = observed >= 100 and negatives > 0 and incomplete == 0
    return {'schema': 'samantha.voice.route-requalification.v1', 'deviceFingerprint': fingerprint,
            'routeKey': route, 'state': 'review_required' if complete else 'awaiting_acoustic_qualification',
            'evidenceSha256': hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest(),
            'interruptions': observed, 'missed': missed, 'negativeSamples': negatives,
            'falseInterruptions': false, 'incomplete': incomplete,
            'cutMs': {'n': len(good), 'max': max(good) if good else None},
            'proposal': {'qualifiedRoutes': {'append': route}, 'requiresOwnerValidation': True} if complete and missed == 0 and false == 0 else None,
            'applied': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    source = Path(args.evidence)
    destination = Path(args.out)
    if destination.resolve() == source.resolve():
        raise ValueError('report_would_overwrite_evidence')
    if destination.exists() or destination.is_symlink():
        raise ValueError('report_output_exists')
    with source.open('rb') as evidence:
        data = evidence.read(MAX_EVIDENCE_BYTES + 1)
    if len(data) > MAX_EVIDENCE_BYTES:
        raise ValueError('evidence_too_large')
    def reject_constant(_):
        raise ValueError('nonfinite_evidence')
    result = report(json.loads(data.decode('utf-8'), parse_constant=reject_constant))
    # Exclusive creation protects evidence, runtime profiles and an existing report from accidental clobber.
    with destination.open('x', encoding='utf-8') as output:
        output.write(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
