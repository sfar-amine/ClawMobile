// Real OS flock, actual canonical Python owner. No production guard bypass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../../installer/termux-lite');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'samantha-qa-lease-'));
const lock = path.join(home, 'deploys/companion-deploy.lock');
fs.mkdirSync(path.dirname(lock)); fs.writeFileSync(lock, '', { mode: 0o600 });
process.env.CLAW_RUNTIME_ROOT = root;
process.env.OPENCLAW_HOME = home;
const originalSpawn = childProcess.spawn;
let lastHelper;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (args[1]?.includes('--repair-lease')) lastHelper = child;
  return child;
};
const { runtimeFile } = require('../dist/runtimeRoot.js');
const sourceCapture = require('../fixtures/qa/restart-source-s24-20261018.json');
process.env.CLAW_RUNTIME_ROOT = sourceCapture.companion_runtime_root.value;
assert.equal(runtimeFile('runtime_mode.py'), path.join(sourceCapture.companion_runtime_root.value, 'runtime_mode.py'));
assert.equal(sourceCapture.companion_runtime_root.absolute, true);
assert.equal(sourceCapture.restart_callers.sources.length, 3);
process.env.CLAW_RUNTIME_ROOT = root;
const gateway = require('../dist/companion/openclawGatewayClient.js');
const down = { host: '127.0.0.1', port: 18789, reachable: false, message: 'fixture' };
const probe = () => childProcess.spawnSync('python3', ['-c',
  'import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_SH|fcntl.LOCK_NB)', lock], { encoding: 'utf8' });
async function refusal() {
  let called = false;
  const result = await gateway.runSerializedRuntimeOperation('restart', async () => {
    called = true; throw new Error('forbidden mutation');
  }, async () => down);
  assert.equal(called, false);
  assert.equal(result.success, false);
  return result;
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
    process.env.CLAW_RUNTIME_ROOT = 'relative-root';
    await refusal(); // The canonical F1 owner rejects relative roots.
    const savedHome = process.env.HOME;
    process.env.HOME = path.join(home, 'fallback-home');
    delete process.env.CLAW_RUNTIME_ROOT;
    const fallback = path.join(process.env.HOME, '.openclaw/releases/current/termux-lite');
    fs.mkdirSync(fallback, { recursive: true });
    fs.copyFileSync(path.join(root, 'runtime_mode.py'), path.join(fallback, 'runtime_mode.py'));
    const fallbackResult = await gateway.runSerializedRuntimeOperation('restart', async () => {
      assert.notEqual(probe().status, 0, 'canonical fallback still holds EX');
      return { success: true, state: 'not_started', message: 'fixture fallback', gateway: down };
    }, async () => down);
    assert.equal(fallbackResult.success, true, 'F1 current-release fallback supplies the helper');
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    process.env.CLAW_RUNTIME_ROOT = root;
    const badRoot = path.join(home, 'bad-helper'); fs.mkdirSync(badRoot);
    fs.writeFileSync(path.join(badRoot, 'runtime_mode.py'), 'print("{bad", flush=True)\n');
    process.env.CLAW_RUNTIME_ROOT = badRoot;
    await refusal(); // A malformed ACK never authorizes the operation.
    fs.writeFileSync(path.join(badRoot, 'runtime_mode.py'), 'import time;time.sleep(30)\n');
    const began = performance.now();
    await refusal();
    assert(performance.now() - began < 4500, 'ACK wait must be bounded');
    process.env.CLAW_RUNTIME_ROOT = root;
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
    console.log('qa runtime repair lease: 9/9 passed (missing lock creation, real flock, helper crash, stop, canonical root/fallback, malformed ACK, deadline, symlink)');
  } finally {
    if (holder) holder.kill('SIGKILL');
    childProcess.spawn = originalSpawn;
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
