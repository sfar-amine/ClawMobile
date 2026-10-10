#!/usr/bin/env python3
"""Read-only contract census. An incomplete census never qualifies a release."""
import argparse
import ast
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCHEMA = 'samantha.runtime.contract-manifest.v2'
CANONICAL = Path(__file__).with_name('runtime-contract-cases.json')
PHASES = {'active', 'pending', 'offline', 'unknown', 'excluded'}
REASONS = {'binary_upload_requires_fixture_file_and_owner_recipe', 'binary_magic_bytes_content_disposition_contract', 'sensitive_or_effectful_transport', 'method_or_contract_requires_final_inventory', 'global_model_change_requires_owner_recipe', 'owner_mutation_requires_dedicated_fixture_recipe', 'pairing_or_biometric_owner_recipe'}
KINDS = {'object', 'array', 'string', 'number', 'boolean', 'null'}
CASE_KEYS = {'id', 'template', 'method', 'phase', 'source', 'types', 'reason', 'test', 'fixtureOwner'}
BLOCKED = re.compile(r'/(?:payments|confirmations|token|socket|setup|terminal)(?:/|$)')
# Any key ending in "token" (sessionToken, bearerToken, refresh_token...) is private, except
# token counters such as maxTokens, totalTokens or contextTokens.
TOKEN_COUNTER_KEY = re.compile(r'^(?:max|total|context|input|output|prompt|completion|cached|cache[_-]?read|cache[_-]?write|cache[_-]?creation|reasoning|remaining|used|num|min)[_-]?tokens?$', re.I)
PRIVATE_KEY = re.compile(r'^(?:.*token|password|secret|client[_-]?secret|authorization|private[_-]?key|cookie|api[_-]?key|credentials)$', re.I)

def private_key(name):
    return bool(PRIVATE_KEY.search(name)) and not TOKEN_COUNTER_KEY.match(name)

PRIVATE_VALUE = re.compile(r'Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})', re.I)

class ContractError(ValueError):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def base_url(value):
    p = urllib.parse.urlsplit(value)
    if p.scheme not in {'http', 'https'} or p.hostname not in {'127.0.0.1', '::1'} or p.username or p.password or p.query or p.fragment or p.path not in {'', '/'}:
        raise ContractError('loopback_base_required')
    try:
        if p.port is not None and not 1 <= p.port <= 65535:
            raise ValueError('port')
    except ValueError:
        raise ContractError('invalid_port')
    return value.rstrip('/')

def validate_manifest(data):
    if not isinstance(data, dict) or set(data) - {'schema', 'base', 'cases', 'limitations'} or not isinstance(data.get('base'), str) or not re.fullmatch(r'[0-9a-f]{40}', data['base']) or data.get('schema') != SCHEMA or not isinstance(data.get('cases'), list) or not data['cases']:
        raise ContractError('invalid_manifest')
    seen = set()
    for c in data['cases']:
        if not isinstance(c, dict) or set(c) - CASE_KEYS or not {'id', 'template', 'method', 'phase', 'source', 'types'}.issubset(c):
            raise ContractError('invalid_case')
        if not isinstance(c['id'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', c['id']) or c['id'] in seen:
            raise ContractError('invalid_case_id')
        seen.add(c['id'])
        if not isinstance(c['source'], str) or not re.fullmatch(r'core(?:#[0-9]{1,5}|@[0-9a-f]{7}(?::server.endpoints)?)', c['source']) or (c.get('reason') is not None and (not isinstance(c['reason'], str) or c['reason'] not in REASONS)):
            raise ContractError('invalid_metadata')
        if c.get('test') is not None and (not isinstance(c['test'], str) or not re.fullmatch(r'scripts/test-[a-z0-9-]+\.(?:cjs|py)', c['test'])):
            raise ContractError('invalid_test_reference')
        if not isinstance(c['phase'], str) or not isinstance(c['method'], (str, type(None))) or c['phase'] not in PHASES or c['method'] not in {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', None} or not isinstance(c['source'], str) or not c['source']:
            raise ContractError('invalid_case_phase')
        if not isinstance(c['template'], str) or any(p in {'.', '..'} for p in c['template'].split('?')[0].split('/')) or not re.fullmatch(r'/v1(?:/[A-Za-z0-9_.:-]+)*(?:\?[A-Za-z0-9_=&.-]+)?', c['template']):
            raise ContractError('invalid_template')
        if not isinstance(c['types'], dict):
            raise ContractError('invalid_types')
        for field, kinds in c['types'].items():
            if not re.fullmatch(r'[A-Za-z0-9_.]+', field) or not isinstance(kinds, (str, list)):
                raise ContractError('invalid_types')
            if not all(isinstance(k, str) and k in KINDS for k in (kinds if isinstance(kinds, list) else [kinds])):
                raise ContractError('invalid_types')
        if c['phase'] == 'active' and (c['method'] != 'GET' or BLOCKED.search(c['template'])):
            raise ContractError('active_case_must_be_safe_get')
    return data

def validate_bindings(bindings, manifest):
    if not isinstance(bindings, dict) or set(bindings) - {c['id'] for c in manifest['cases']}:
        raise ContractError('invalid_bindings')
    for b in bindings.values():
        if not isinstance(b, dict) or set(b) != {'params'} or not isinstance(b['params'], dict):
            raise ContractError('binding_override_forbidden')
        for key, val in b['params'].items():
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9]*', key) or not isinstance(val, str) or not re.fullmatch(r'[A-Za-z0-9_:-]{1,160}', val):
                raise ContractError('invalid_binding_parameter')
    return bindings

def resolve_path(case, binding):
    params = re.findall(r':([A-Za-z][A-Za-z0-9]*)', case['template'])
    values = binding.get('params', {})
    if set(values) != set(params):
        return None
    path = case['template']
    for key in params:
        path = path.replace(':' + key, urllib.parse.quote(values[key], safe=''))
    return path

def kind(value):
    if value is None: return 'null'
    if isinstance(value, bool): return 'boolean'
    if isinstance(value, str): return 'string'
    if isinstance(value, list): return 'array'
    if isinstance(value, dict): return 'object'
    if isinstance(value, (int, float)): return 'number'
    return 'unknown'

def check_types(data, expected):
    for field, kinds in expected.items():
        value = data
        for part in field.split('.'):
            if not isinstance(value, dict) or part not in value:
                return False
            value = value[part]
        if kind(value) not in (kinds if isinstance(kinds, list) else [kinds]):
            return False
    return isinstance(data, dict)

def secret_present(data):
    if isinstance(data, dict):
        return any((private_key(str(k)) and v not in (None, '', False)) or secret_present(v) for k, v in data.items())
    if isinstance(data, list): return any(secret_present(v) for v in data)
    return isinstance(data, str) and bool(PRIVATE_VALUE.search(data))

def replay_permitted(response, operation_id):
    """Documentation helper only: this census never sends any mutation/replay."""
    r = response.get('receipt') if isinstance(response, dict) else None
    return bool(response.get('success') is True and response.get('state') in {'completed', 'accepted', 'cancelled', 'already_closed'} and isinstance(r, dict) and r.get('operationId') == operation_id)

def fetch_json(opener, url, timeout):
    started = time.monotonic()
    try:
        with opener.open(urllib.request.Request(url, method='GET', headers={'Accept': 'application/json'}), timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            status = response.status
        if len(raw) > 2 * 1024 * 1024:
            return None, status, 'response_too_large', time.monotonic() - started
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return None, status, 'invalid_json', time.monotonic() - started
        return data, status, None, time.monotonic() - started
    except urllib.error.HTTPError as e:
        return None, e.code, 'http_error', time.monotonic() - started
    except (OSError, urllib.error.URLError, TimeoutError):
        return None, None, 'transport_error_no_retry', time.monotonic() - started

ACCEPTANCE = Path(__file__).resolve().parents[2] / "installer/termux-lite/companion-acceptance.py"

def read_budgets(source=ACCEPTANCE):
    """Read the literal recipe table without executing the acceptance program."""
    tree = ast.parse(source.read_text(encoding="utf-8"))
    reads = next(ast.literal_eval(node.value) for node in tree.body
                 if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "READS" for target in node.targets))
    budgets = {}
    for path, seconds in reads:
        route = "/v1" + path.split("?")[0]
        budgets[route] = max(budgets.get(route, 0), seconds)
    return budgets

READ_BUDGET_SECONDS = read_budgets()

def request_timeout(path, override):
    return override if override is not None else READ_BUDGET_SECONDS.get(path.split("?")[0], 1) + 2

def report(base, manifest, bindings=None, timeout=None, fixture=False):
    base = base_url(base)
    validate_manifest(manifest)
    if not fixture and manifest != json.loads(CANONICAL.read_text()):
        raise ContractError('canonical_manifest_required')
    bindings = validate_bindings(bindings or {}, manifest)
    if timeout is not None and (not isinstance(timeout, (float, int)) or isinstance(timeout, bool) or not 0.01 <= timeout <= 30):
        raise ContractError('invalid_timeout')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    rows = []
    for case in manifest['cases']:
        row = {'id': case['id'], 'source': case['source'], 'phase': case['phase'], 'attempts': 0}
        if case['phase'] != 'active':
            row.update(verdict='excluded' if case['phase'] == 'excluded' else 'unqualified', reason=case.get('reason') or case['phase'])
        else:
            path = resolve_path(case, bindings.get(case['id'], {}))
            if path is None:
                row.update(verdict='unqualified', reason='fixture_binding_required')
            else:
                data, status, error, elapsed = fetch_json(opener, base + path, request_timeout(path, timeout))
                row.update(attempts=1, httpStatus=status, elapsedMs=round(elapsed * 1000))
                if error: row.update(verdict='failed', reason=error)
                elif secret_present(data): row.update(verdict='failed', reason='secret_detected')
                elif not check_types(data, case['types']): row.update(verdict='failed', reason='contract_type_mismatch')
                else: row.update(verdict='passed')
        rows.append(row)
    # Inventory is drift evidence only, never the completeness authority.
    inventory, status, error, _ = fetch_json(opener, base + '/v1', request_timeout('/v1', timeout))
    advertised = inventory.get('endpoints') if isinstance(inventory, dict) else None
    templates = {c['template'].split('?')[0] for c in manifest['cases']}
    drift = isinstance(advertised, list) and any(not isinstance(p, str) or p not in templates for p in advertised)
    inventory_ok = error is None and isinstance(advertised, list) and not drift
    complete = inventory_ok and all(r['verdict'] in {'passed', 'excluded'} for r in rows)
    return {'schema': 'samantha.runtime.contract-report.v2', 'manifestBase': manifest.get('base'),
            'manifestDigest': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
            'scope': 'http_read_contracts_only', 'state': 'fixture_passed' if complete and fixture else 'passed' if complete else 'incomplete',
            'complete': complete and not fixture, 'fixtureReadChecksPassed': complete if fixture else None, 'physicalQualification': False, 'mutationQualification': False,
            'inventory': {'httpStatus': status, 'matched': inventory_ok, 'reason': error or ('inventory_drift' if drift else 'inventory_missing' if not isinstance(advertised, list) else None)},
            'cases': rows}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8765')
    parser.add_argument('--bindings', type=Path)
    parser.add_argument('--timeout', type=float, help='Explicit timeout override; default uses per-route measured read budgets plus 2 seconds')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = json.loads(CANONICAL.read_text())
        bindings = json.loads(args.bindings.read_text()) if args.bindings else {}
        result = report(args.base_url, manifest, bindings, args.timeout)
    except (ContractError, ValueError, OSError):
        result = {'schema': 'samantha.runtime.contract-report.v2', 'state': 'invalid_configuration', 'complete': False, 'reason': 'configuration_rejected'}
    # No response body, URL, parameter value, owner header, operation id or exception text.
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(result['state'])
    return 0 if result.get('complete') else 2

if __name__ == '__main__':
    raise SystemExit(main())
