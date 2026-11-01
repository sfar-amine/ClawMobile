'use strict';
// Written for test-startup-triage-optout.py (not an S24 capture). Runs the exact public
// `triageAfterFailure` body of an OpenClaw 2026.9.6 or 2026.10.9 `triage-failure-*.mjs`, original or
// patched by the existing owner, in a VM with inert owners: no triage process, claim, model, network
// or host environment. Prints, per case, what the function reached and what it returned.
// Usage: node startup-triage-optout-harness.cjs <triage-failure module>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
assert(file, 'module path required');
const text = fs.readFileSync(file, 'utf8');
let start = text.indexOf('async function triageAfterFailure(');
assert(start >= 0, 'triageAfterFailure');
const end = text.indexOf('\n//#endregion', start);
assert(end > start);
const body = text.slice(start, end);

async function run(env, kind) {
  const effects = [];
  const logs = [];
  const fixtureEnv = {...env};
  class ExitError extends Error {}
  class TriageAttemptFailedError extends Error {}
  const sandbox = {
    AbortSignal, AbortController, Error, String, Date, Object, JSON,
    process: {env: fixtureEnv, argv: ['fixture-node', '/fixture/openclaw.mjs'], platform: 'android', pid: 4242},
    ExitError, TriageAttemptFailedError,
    isGatewayExternallySupervised: () => false,
    createEmbeddedStateSignalBridge: () => {
      effects.push('signal-bridge');
      return {signal: new AbortController().signal, dispose: () => effects.push('bridge-disposed')};
    },
    resolveStateDir: () => '/fixture/state',
    scrubDoctorErrorMessage: (value) => value,
    redactSupportString: (value) => String(value),
    withConsoleLogsRoutedToStderr: async (work) => work(),
    resolveOpenClawPackageRoot: async () => { effects.push('package-root'); return '/fixture/openclaw'; },
    realpathSync: (value) => value,
    detectRespawnSupervisor: () => null,
    resolveTriageEntrypoint: async () => { effects.push('entrypoint'); return ['fixture-node', '/fixture/openclaw.mjs', 'triage']; },
    queueManagedUpdateTriage: async () => { effects.push('queue-update'); return false; },
    continueTriageInFreshProcess: async (params) => {
      effects.push('fresh-process:' + params.failure.kind);
      assert.equal(sandbox.process.env.OPENCLAW_SHELL, 'exec');
      return 'completed';
    },
    startManagedServiceUpdateHandoff: async () => { throw Error('no managed supervisor in this fixture'); },
    commitManagedServiceUpdateHandoff: async () => false,
    cancelManagedServiceUpdateHandoff: async () => {},
    renderTriagePrompt: () => '',
    path: {join: (...parts) => parts.join('/')},
    fs$1: {mkdir: async () => {}, writeFile: async () => {}},
  };
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);
  const runtime = {error: (message) => logs.push(String(message)), log: (message) => logs.push(String(message))};
  const returned = await sandbox.triageAfterFailure(runtime, {
    kind, phase: 'startup', error: 'fixture startup failure', gateway: 'verify-running',
  }, undefined, undefined);
  return {
    returned: returned === undefined ? null : returned,
    effects,
    optOutLogged: logs.some((line) => line.includes('OPENCLAW_STARTUP_TRIAGE=off')),
    shellRestored: !Object.hasOwn(fixtureEnv, 'OPENCLAW_SHELL'),
  };
}

(async () => {
  const result = {
    offStartup: await run({OPENCLAW_STARTUP_TRIAGE: 'off'}, 'gateway-startup'),
    unsetStartup: await run({}, 'gateway-startup'),
    otherValueStartup: await run({OPENCLAW_STARTUP_TRIAGE: 'on'}, 'gateway-startup'),
    offUpdate: await run({OPENCLAW_STARTUP_TRIAGE: 'off'}, 'update'),
  };
  process.stdout.write(JSON.stringify(result) + '\n');
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exit(1);
});
