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
const originalHomeDir=os.homedir;os.homedir=()=>home;
const current=path.join(home,'.openclaw/releases/current/termux-lite');
fs.mkdirSync(path.dirname(current),{recursive:true});fs.symlinkSync(root,current,'dir');
const pointCurrent=target=>{fs.unlinkSync(current);fs.symlinkSync(target,current,'dir');};
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
assert.equal(runtimeFile('runtime_mode.py'), path.join(current, 'runtime_mode.py')); // Inherited pin is observed but never overrides current.
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
    process.env.CLAW_RUNTIME_ROOT = 'relative-stale-pin';
    const promoted=path.join(home,'promoted-termux-lite');fs.mkdirSync(promoted);
    fs.copyFileSync(path.join(root,'runtime_mode.py'),path.join(promoted,'runtime_mode.py'));
    pointCurrent(promoted);
    const promotedResult=await gateway.runSerializedRuntimeOperation('restart',async()=>{
      assert.notEqual(probe().status,0,'promoted current helper still holds EX');
      return {success:true,state:'not_started',message:'fixture current promotion',gateway:down};
    },async()=>down);
    assert.equal(promotedResult.success,true,'stale inherited root is ignored after promotion');
    const badRoot = path.join(home, 'bad-helper'); fs.mkdirSync(badRoot);
    fs.writeFileSync(path.join(badRoot, 'runtime_mode.py'), 'print("{bad", flush=True)\n');
    pointCurrent(badRoot);
    await refusal(); // A malformed ACK never authorizes the operation.
    fs.writeFileSync(path.join(badRoot, 'runtime_mode.py'), 'import time;time.sleep(30)\n');
    const began = performance.now();
    await refusal();
    assert(performance.now() - began < 4500, 'ACK wait must be bounded');
    pointCurrent(root);
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
    console.log('qa runtime repair lease: 9/9 passed (missing lock creation, real flock, helper crash, stop, canonical current/promotion, malformed ACK, deadline, symlink)');
  } finally {
    if (holder) holder.kill('SIGKILL');
    childProcess.spawn = originalSpawn;os.homedir=originalHomeDir;
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
