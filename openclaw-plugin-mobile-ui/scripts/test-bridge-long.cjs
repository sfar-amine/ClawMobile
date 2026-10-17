const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-long-'));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR = root;
const exec = require('../dist/companion/remoteBridgeExec');
let calls = 0;
let finish;
exec.runExecWait = async () => { calls++; return new Promise(resolve => { finish = resolve; }); };
const bridge = require('../dist/companion/remoteBridge');
(async () => {
  try {
    const request = {requestId:'long-read', method:'exec_wait', params:{command:'fixture', timeoutMs:60000}};
    const before = Date.now();
    const running = await bridge.submitRemoteBridgeRequest(request);
    assert.equal(running.state, 'running');
    assert.ok(Date.now() - before >= 11900);
    assert.ok(Date.now() - before < 15000, 'public response budget exceeded');
    assert.equal((await bridge.submitRemoteBridgeRequest(request)).state, 'running');
    assert.equal(bridge.getRemoteBridgeRequest('long-read').state, 'running');
    assert.equal(calls, 1);
    finish({success:true, exitCode:0, stdout:'done'});
    await new Promise(resolve => setImmediate(resolve));
    const done = bridge.getRemoteBridgeRequest('long-read');
    assert.equal(done.state, 'completed');
    assert.equal(done.result.stdout, 'done');
    assert.equal((await bridge.submitRemoteBridgeRequest(request)).state, 'completed');
    assert.equal(calls, 1);
    exec.runExecWait = async () => { throw new Error('fixture_failure'); };
    const failed = await bridge.submitRemoteBridgeRequest({...request, requestId:'failed-read'});
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'fixture_failure');
    // Replay the real orphan shape: never claim completion or redispatch.
    const capture = require('../fixtures/s24-2026-10-11b/f6/remote-bridge-stuck-receipts.json');
    const sample = capture.receipts.find(r => !r.owner.instancePidAlive);
    fs.writeFileSync(path.join(root, 'requests', 'orphan.json'), JSON.stringify({...sample, requestId:'orphan'}));
    assert.equal(bridge.getRemoteBridgeRequest('orphan').state, 'indeterminate');
    console.log('bridge long: response <15s, completion retained, deduplication, failure and real orphan pass');
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
