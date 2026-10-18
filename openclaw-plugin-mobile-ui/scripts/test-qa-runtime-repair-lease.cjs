// Real OS flock, actual canonical Python owner. No production guard bypass.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../../installer/termux-lite');
const dist = path.resolve(__dirname, '../dist');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'samantha-qa-lease-'));
const lock = path.join(home, 'deploys/companion-deploy.lock');
fs.mkdirSync(path.dirname(lock)); fs.writeFileSync(lock, '', { mode: 0o600 });
process.env.CLAW_RUNTIME_ROOT = root;
process.env.OPENCLAW_HOME = home;
const originalHomeDir=os.homedir;os.homedir=()=>home;
const current=path.join(home,'.openclaw/releases/current/termux-lite');
fs.mkdirSync(path.dirname(current),{recursive:true});fs.symlinkSync(root,current,'dir');
const pointCurrent=target=>{fs.unlinkSync(current);fs.symlinkSync(target,current,'dir');};
const originalSpawn = childProcess.spawn;
let lastHelper;
const leaseHelpers = [];
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (args[1]?.includes('--repair-lease')) { lastHelper = child; leaseHelpers.push(args[1][0]); }
  return child;
};
const { runtimeFile, checkoutFile } = require('../dist/runtimeRoot.js');
const sourceCapture = require('../fixtures/qa/restart-source-s24-20261018.json');
process.env.CLAW_RUNTIME_ROOT = sourceCapture.companion_runtime_root.value;
assert.equal(runtimeFile('runtime_mode.py'), path.join(current, 'runtime_mode.py')); // Inherited pin is observed but never overrides current.
// The lease protocol is versioned with the checkout (S24: <checkout>/installer/termux-lite), not with current.
assert.equal(checkoutFile('runtime_mode.py'), path.join(root, 'runtime_mode.py'));
assert.equal(sourceCapture.companion_runtime_root.value.endsWith('/installer/termux-lite'), true);
assert.equal(sourceCapture.companion_runtime_root.absolute, true);
assert.equal(sourceCapture.restart_callers.sources.length, 3);
// Byte-exact S24 helper from before Q12 (no --repair-lease): what a Tier0 rollback restores as current.
const preQ12 = fs.readFileSync(path.join(__dirname, '../fixtures/qa/runtime-mode-pre-q12-s24-20261018.py'));
assert.equal(crypto.createHash('sha256').update(preQ12).digest('hex'), sourceCapture.companion_runtime_root.runtime_mode_sha256);
assert.equal(preQ12.length, sourceCapture.companion_runtime_root.runtime_mode_size_bytes);
process.env.CLAW_RUNTIME_ROOT = root;
const gateway = require('../dist/companion/openclawGatewayClient.js');
// A copy of the compiled Companion uses the helper next to its own copy, never
// this checkout's nor current's: the helper is located from the module only.
let relocations = 0;
function relocatedGateway(helperSource) {
  const repo = path.join(home, `checkout-${++relocations}`);
  fs.cpSync(dist, path.join(repo, 'openclaw-plugin-mobile-ui/dist'), { recursive: true });
  const installer = path.join(repo, 'installer/termux-lite'); fs.mkdirSync(installer, { recursive: true });
  if (helperSource !== null) fs.writeFileSync(path.join(installer, 'runtime_mode.py'), helperSource);
  return require(path.join(repo, 'openclaw-plugin-mobile-ui/dist/companion/openclawGatewayClient.js'));
}
const down = { host: '127.0.0.1', port: 18789, reachable: false, message: 'fixture' };
const probe = () => childProcess.spawnSync('python3', ['-c',
  'import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_SH|fcntl.LOCK_NB)', lock], { encoding: 'utf8' });
async function refusal(owner = gateway) {
  let called = false;
  const result = await owner.runSerializedRuntimeOperation('restart', async () => {
    called = true; throw new Error('forbidden mutation');
  }, async () => down);
  assert.equal(called, false);
  assert.equal(result.success, false);
  return result;
}
async function leased(message) {
  const result = await gateway.runSerializedRuntimeOperation('restart', async () => {
    assert.notEqual(probe().status, 0, `${message}: EX is held during the mutation`);
    return { success: true, state: 'not_started', message, gateway: down };
  }, async () => down);
  assert.equal(result.success, true, message);
  assert.equal(probe().status, 0, `${message}: lease released`);
}
(async () => {
  let holder;
  try {
    holder = originalSpawn('python3', ['-c',
      'import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_SH); print("held",flush=True);sys.stdin.buffer.read()', lock],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    await once(holder.stdout, 'data');
    const busyResult = await refusal(); // Shared QA campaign blocks every start/stop/restart.
    assert.match(busyResult.message, /Runtime lock is held/);
    const holderClosed = once(holder, 'close'); holder.stdin.end(); await holderClosed; holder = undefined;
    assert.equal(probe().status, 0);

    const result = await gateway.runSerializedRuntimeOperation('restart', async () => {
      assert.notEqual(probe().status, 0, 'EX is held before mutation');
      const closed = once(lastHelper, 'close'); lastHelper.kill('SIGKILL'); await closed;
      assert.notEqual(probe().status, 0, 'owner retains EX after helper SIGKILL');
      return { success: true, state: 'not_started', message: 'fixture mutation', gateway: down };
    }, async () => down);
    assert.equal(result.success, true);
    assert.equal(probe().status, 0, 'finally releases retained owner fd');

    fs.mkdirSync(path.join(home, 'tier0'));
    fs.writeFileSync(path.join(home, 'tier0/emergency-stop.json'), '{"enabled":true}');
    await refusal();
    assert.equal(probe().status, 0, 'refused lease does not leak fd/lock');
    fs.unlinkSync(path.join(home, 'tier0/emergency-stop.json'));

    // Tier0 rollback to a release older than Q12: current serves a helper that
    // rejects --repair-lease. Watchdog, health-manager and check_gateway repairs
    // all reach this owner; none may be blocked until the next deploy.
    const oldRelease = path.join(home, 'pre-q12-termux-lite'); fs.mkdirSync(oldRelease);
    fs.writeFileSync(path.join(oldRelease, 'runtime_mode.py'), preQ12);
    const oldCli = childProcess.spawnSync('python3', [path.join(oldRelease, 'runtime_mode.py'), '--repair-lease'], { encoding: 'utf8' });
    assert.equal(oldCli.status, 2); assert.match(oldCli.stderr, /unrecognized arguments: --repair-lease/);
    pointCurrent(oldRelease);
    process.env.CLAW_RUNTIME_ROOT = 'relative-stale-pin';
    leaseHelpers.length = 0;
    await leased('pre-Q12 current release does not block the Companion lease');
    fs.unlinkSync(current); // Pruned or not yet installed: same checkout helper.
    await leased('absent current release does not block the Companion lease');
    assert.deepEqual(leaseHelpers, [path.join(root, 'runtime_mode.py'), path.join(root, 'runtime_mode.py')]);
    fs.symlinkSync(root, current, 'dir');
    process.env.CLAW_RUNTIME_ROOT = root;

    await refusal(relocatedGateway('print("{bad", flush=True)\n')); // A malformed ACK never authorizes the operation.
    const sleeping = relocatedGateway('import time;time.sleep(30)\n');
    const began = performance.now();
    await refusal(sleeping);
    assert(performance.now() - began < 4500, 'ACK wait must be bounded');
    await refusal(relocatedGateway(null)); // A checkout without its helper fails closed.
    assert.equal(probe().status, 0, 'refused relocated leases do not leak fd/lock');
    fs.unlinkSync(lock);
    fs.symlinkSync(path.join(home, 'foreign'), lock);
    await refusal();
    assert.equal(fs.existsSync(path.join(home, 'foreign')), false);
    fs.unlinkSync(lock); // A reinstallation may have no deployment lock yet.
    const recreated = await gateway.runSerializedRuntimeOperation('restart', async () => {
      assert.notEqual(probe().status,0,'new canonical lock is held EX during repair');
      return {success:true,state:'not_started',message:'fixture repair after reinstall',gateway:down};
    },async()=>down);
    assert.equal(recreated.success,true);
    assert.equal(fs.statSync(lock).mode&0o777,0o600);
    assert.equal(probe().status,0,'repair releases recreated lock');
    console.log('qa runtime repair lease: 10/10 passed (missing lock creation, real flock, helper crash, stop, checkout helper despite pre-Q12 or absent current, malformed ACK, deadline, missing checkout helper, symlink)');
  } finally {
    if (holder) holder.kill('SIGKILL');
    childProcess.spawn = originalSpawn;os.homedir=originalHomeDir;
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
