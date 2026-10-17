/* Real S24 modules in a network-free VM; clocks/sockets are injected, no live outage. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const fixture = path.join(__dirname, '../../openclaw-plugin-mobile-ui/fixtures/s24-2026-10-16-whatsapp-recovery');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'openclaw-compat/whatsapp-network-recovery.json')));
function source(entry, patched = true) {
  let text = fs.readFileSync(path.join(fixture, entry.root, entry.path), 'utf8');
  if (patched) for (const [before, after] of entry.replacements) text = text.replace(before, after);
  return text;
}
let now = 1_000_000, random = .5;
const sandbox = {
  AbortController, Promise, Set, Map, Math: Object.assign(Object.create(Math), {random: () => random}),
  Date: class extends Date {static now() {return now;}},
  DEFAULT_WHATSAPP_SOCKET_TIMING: {connectTimeoutMs: 60000},
  getStatusCode: error => error.status,
  formatError: error => String(error?.error || error?.message || error),
  computeBackoff: (p, n) => Math.min(p.maxMs, p.initialMs * p.factor ** (n - 1)),
  channelReadyPatch: extra => ({running: true, connected: true, lifecycle: 'ready', terminalDisconnect: undefined, ...extra}),
  channelStoppedPatch: extra => ({running: false, connected: false, lifecycle: 'stopped', ...extra}),
  createTransportActivityStatusPatch: at => ({lastTransportActivityAt: at}),
};
vm.createContext(sandbox);
const controllerText = source(manifest.files[0]);
vm.runInContext(controllerText.slice(controllerText.indexOf('//#region'), controllerText.lastIndexOf('export {')), sandbox);
const monitorText = source(manifest.files[1]);
vm.runInContext(monitorText.slice(monitorText.indexOf('const LIFECYCLE_BY_HEALTH_STATE'), monitorText.indexOf('//#region extensions/whatsapp/src/auto-reply/monitor/listener-log')), sandbox);
const supervisorText = source(manifest.files[2]);
vm.runInContext(supervisorText.slice(supervisorText.indexOf('function hasOwnedWhatsAppRecovery'), supervisorText.indexOf('const log =')), sandbox);
const Controller = sandbox.WhatsAppConnectionController;
const make = (extra = {}) => new Controller({
  accountId: 'fixture', authDir: '/never-used', keepAlive: true, heartbeatSeconds: 60,
  reconnectPolicy: {initialMs: 2000, maxMs: 30000, factor: 1.8, maxAttempts: 12},
  isNonRetryableStatus: n => n === 440, ...extra
});
const dns = {status: 408, code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN web.whatsapp.com'};
let tests = 0;
function test(name, fn) {fn(); tests++; console.log('PASS ' + name);}
test('all patched modules parse without changing import/export resolution', () => {
  for (const entry of manifest.files) new vm.Script(source(entry).replace(/^import .*;\n/gm, '').replace(/^export .*;\n?/gm, ''));
});
test('real regression: 12 exhausted attempts remain recoverable, one slow attempt per wake', () => {
  const c = make();
  for (let n = 1; n < 12; n++) assert.equal(c.resolveSetupErrorDecision(dns).delayMs, Math.min(30000, 2000 * 1.8 ** (n - 1)));
  for (const expected of [60000, 120000, 300000, 300000, 300000]) {
    const d = c.resolveSetupErrorDecision(dns);
    assert.equal(d.action, 'retry'); assert.equal(d.healthState, 'reconnecting'); assert.equal(d.delayMs, expected);
  }
  for (let i = 0; i < 10000; i++) c.resolveSetupErrorDecision(dns);
  assert.equal(c.getReconnectAttempts(), 14);
});
test('jitter stays bounded, including the five-minute ceiling', () => {
  for (const sample of [0, .1, .9, .999999]) {
    random = sample;
    const c = make(); c.reconnectAttempts = 11;
    for (const [low, high] of [[48000, 72000], [96000, 144000], [240000, 300000]]) {
      const d = c.resolveSetupErrorDecision(dns); assert.ok(d.delayMs >= low && d.delayMs <= high);
    }
  }
  random = .5;
});
test('401 and 440 stop immediately even after a long outage, without credential deletion', () => {
  for (const status of [401, 440]) {
    const c = make(); c.reconnectAttempts = 14;
    const d = c.resolveCloseDecision({status, isLoggedOut: false, error: {code: 'EAI_AGAIN'}});
    assert.equal(d.action, 'stop'); assert.equal(d.healthState, status === 401 ? 'logged-out' : 'conflict');
  }
});
test('bad session, mismatch, forbidden, restart-required and unknown errors do not retry forever', () => {
  for (const status of [500, 411, 403, 515, 499, 999]) {
    const c = make(); c.reconnectAttempts = 11;
    assert.equal(c.resolveSetupErrorDecision({status}).action, 'stop');
  }
  assert.equal(make().resolveSetupErrorDecision(new Error('unknown')), null);
  const c = make(); c.reconnectAttempts = 11;
  assert.equal(c.consumeReconnectAttempt().action, 'stop'); // unstable auth remains bounded
});
test('explicit raw transport codes and known network status codes recover', () => {
  for (const error of [{code:'EAI_AGAIN'}, {code:'ENETUNREACH'}, {status:408}, {status:428}, {status:503}]) {
    const c = make(); c.reconnectAttempts = 11; assert.equal(c.resolveSetupErrorDecision(error).action, 'retry');
  }
});
test('flapping and stale transport do not reset; two minutes stable with recent traffic do', () => {
  const c = make(); c.reconnectAttempts = 14;
  c.current = {startedAt: now - 119999, lastTransportActivityAt: now};
  assert.equal(c.resolveSetupErrorDecision(dns).delayMs, 300000);
  c.current = {startedAt: now - 180000, lastTransportActivityAt: now - 90000};
  assert.equal(c.resolveSetupErrorDecision(dns).delayMs, 300000);
  c.current = {startedAt: now - 120000, lastTransportActivityAt: now};
  assert.equal(c.resolveSetupErrorDecision(dns).reconnectAttempts, 1);
});
test('supervisor leaves an owned retry alone but rescues expired, stopped or invalid leases', () => {
  const status = sandbox.createWebChannelStatusController();
  status.noteClose({healthState:'reconnecting', statusCode:408, retryDelayMs:300000, reconnectAttempts:14});
  const s = status.snapshot();
  assert.equal(s.connected, false); assert.equal(s.lifecycle, 'recovering');
  assert.equal(sandbox.hasOwnedWhatsAppRecovery('whatsapp', s, now), true);
  assert.equal(sandbox.hasOwnedWhatsAppRecovery('whatsapp', s, now + 420000), false);
  assert.equal(sandbox.hasOwnedWhatsAppRecovery('slack', s, now), false);
  for (const changed of [{running:false}, {terminalDisconnect:true}, {lifecycle:'blocked'}, {recoveryRetryAt:Infinity}, {recoveryRetryAt:now+420001}])
    assert.equal(sandbox.hasOwnedWhatsAppRecovery('whatsapp', {...s, ...changed}, now), false);
  status.noteConnected(); assert.equal(s.recoveryRetryAt, null); assert.equal(s.connected, true);
  status.noteClose({healthState:'logged-out', retryDelayMs:300000});
  assert.equal(s.recoveryRetryAt, null);
  status.markStopped(); assert.equal(s.recoveryRetryAt, null);
});
test('monitor carries the actual decision delay for setup and connected failures', () => {
  assert.match(monitorText, /retryDelayMs: setupDecision.delayMs/);
  assert.match(monitorText, /retryDelayMs: decision.delayMs/);
  // Outbound recovery/dedupe remains byte-for-byte upstream.
  const original = source(manifest.files[1], false);
  const region = t => t.slice(t.indexOf('const periodicDrainInterval'), t.indexOf('const inboundPolicy = resolveWhatsAppInboundPolicy', t.indexOf('const periodicDrainInterval')));
  assert.equal(region(monitorText), region(original));
});
(async () => {
  // Run the actual upstream supervisor with controlled time and no live services.
  const policy = fs.readFileSync(path.join(fixture, 'openclaw/dist/channel-health-policy-DnqLKLPL.mjs'), 'utf8');
  sandbox.isFutureDateTimestampMs = (at, {nowMs}) => at > nowMs;
  sandbox.createSubsystemLogger = () => ({error: message => {throw new Error(message);}});
  sandbox.resolveTimerTimeoutMs = (value, fallback) => value ?? fallback;
  let scheduled;
  sandbox.setTimeout = fn => {scheduled = fn; return {unref(){}};};
  sandbox.clearTimeout = () => {};
  vm.runInContext(policy.slice(policy.indexOf('//#region'), policy.lastIndexOf('export {')), sandbox);
  vm.runInContext(supervisorText.slice(supervisorText.indexOf('//#region'), supervisorText.lastIndexOf('export {')), sandbox);
  const status = sandbox.createWebChannelStatusController();
  status.noteClose({healthState:'reconnecting', statusCode:408, retryDelayMs:300000, reconnectAttempts:14});
  const calls = [];
  const manager = {
    getAutostartSuppression: () => null,
    getRuntimeSnapshot: () => ({channelAccounts:{whatsapp:{default:status.snapshot()}}}),
    isAmbientAutostartSuppressed: () => false, isAccountListed: () => true,
    isHealthMonitorEnabled: () => true, isManuallyStopped: () => false,
    isAutoRestartScheduled: () => false,
    stopChannel: async () => calls.push('stop'),
    resetRestartAttempts: () => calls.push('reset'),
    startChannel: async () => calls.push('start')
  };
  const supervisor = sandbox.startChannelHealthMonitor({channelManager:manager,timing:{monitorStartupGraceMs:0}});
  now += 180000; // Beyond upstream's 2-minute reconnect grace, but inside the owned deadline.
  scheduled(); await new Promise(setImmediate); assert.deepEqual(calls, []);
  now += 240001; // Hung controller: the existing supervisor regains authority.
  scheduled(); await new Promise(setImmediate); assert.deepEqual(calls, ['stop','reset','start']);
  status.noteConnected(); now += 300000;
  scheduled(); await new Promise(setImmediate); assert.equal(calls.length, 3);
  supervisor.stop();
  tests++; console.log('PASS actual supervisor defers owned recovery, rescues expiry, accepts restored connection');

  const abort = new AbortController(), c = make({abortSignal:abort.signal});
  let release;
  c.openConnectionOwned = () => new Promise(resolve => {release = resolve;});
  const first = c.openConnection({});
  await assert.rejects(c.openConnection({}), /already in progress/);
  release({connected:true}); await first;
  assert.equal(c.connectionSetupPromise, null);
  abort.abort();
  assert.equal(c.resolveSetupErrorDecision(dns), 'aborted');
  assert.equal(c.shouldRetryDisconnect(), false);
  tests++; console.log('PASS existing single-flight and cancellation preserved');
  console.log(tests + ' recovery behavior tests passed');
})().catch(e => {console.error(e); process.exitCode=1;});
