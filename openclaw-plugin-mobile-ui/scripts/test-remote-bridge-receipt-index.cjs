// S24 07/11 18:08-18:30: the Companion answered no HTTP request for seconds at a time (about 40 s during a turn).
// Every new task step and every task_status of the Remote Bridge read and parsed all receipts synchronously:
// 57 664 files on the S24 (40 days, the read retention keeps 50 000), 1.2 s per pass with a warm cache.
// Real capture: fixtures/s24-2026-11-07-bridge-receipt-scan/scan-and-freeze.json (counts, method mix, sampler).
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-receipt-index-'));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR=root;
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-11-07-bridge-receipt-scan/scan-and-freeze.json'),'utf8'));
const dir=path.join(root,'requests');fs.mkdirSync(dir,{recursive:true});
const hash=(method,params)=>crypto.createHash('sha256').update(JSON.stringify({method,params})).digest('hex');

function receipt(id,extra={}){return {requestId:id,method:'process_status',paramsHash:'a'.repeat(64),state:'completed',
  mutationRisk:'read',instanceId:'old-instance',receivedAt:1793000000000,startedAt:1793000000001,completedAt:1793000000002,
  sessionId:'mcp:claude-chat',result:{state:'exited',exitCode:0,tail:'x'.repeat(160)},...extra};}
function monitor(){let last=performance.now(),max=0;const timer=setInterval(()=>{const now=performance.now();max=Math.max(max,now-last);last=now;},5);
  // The pause still running at stop() counts too: a synchronous pass can end before the first tick.
  return {stop(){clearInterval(timer);return Math.max(0,Math.max(max,performance.now()-last)-5);}};}
function legacyScan(taskId,stepId){ // the former findTaskStepReceipt, for the measurement only
  for(const name of fs.readdirSync(dir).filter(n=>/^[A-Za-z0-9._:-]{1,128}\.json$/.test(n))){
    try{const row=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));if(row.taskId===taskId&&row.stepId===stepId)return row;}catch{}
  }
  return null;
}

(async()=>{
  // The S24 directory as captured: count, task/step share and method mix (bodies kept short for the CI disk).
  assert.equal(fixture.files,57664);assert.equal(fixture.withTaskAndStep,13303);assert.ok(fixture.oldestDays>=39);
  assert.equal(fixture.syncScanGatewayNode.scanMs,1202);
  const polls=fixture.sampler.lines.map(line=>/ lat=(\d{3}) (\d+\.\d+) comp=\[([A-Z]) (\d+) (\d+)\]/.exec(line)).filter(Boolean);
  const freezes=polls.filter(([,,seconds])=>Number(seconds)>=0.8);
  assert.ok(polls.length>=50&&freezes.length>=5,'the sampler saw the Companion silent for 0.8-2 s at a time: '+freezes.length);
  assert.ok(freezes.filter(([,,,state])=>state==='R'||state==='D').length>=4,'busy computing or waiting for the disk (R/D)');
  const methods=Object.entries(fixture.methods);
  for(let i=0;i<fixture.files-5;i++){
    const method=methods[i%methods.length][0],stepped=i<fixture.withTaskAndStep;
    fs.writeFileSync(path.join(dir,`r${i}.json`),JSON.stringify(receipt(`r${i}`,{method,
      ...(stepped?{taskId:'mcp:claude-chat:k'+(i%4000),stepId:'s'+i}:{taskId:'qa:qa-20261019-app-0460b4'})})));
  }
  // A step already executed by a previous instance (claw_exec reused action_key): must never run again.
  fs.writeFileSync(path.join(dir,'known-orange.json'),JSON.stringify(receipt('known-orange',{method:'ping',paramsHash:hash('ping',{}),
    taskId:'mcp:claude-chat:orange-app-surface-live',stepId:'share1',mutationRisk:'read'})));
  for(const [i,step] of ['a','b','c'].entries())
    fs.writeFileSync(path.join(dir,`multi-${step}.json`),JSON.stringify(receipt(`multi-${step}`,{taskId:'mcp:claude-chat:multi',stepId:step,receivedAt:1793000000000+i})));
  fs.writeFileSync(path.join(dir,'broken.json'),'{');
  assert.equal(fs.readdirSync(dir).length,fixture.files,"same receipt count as the S24");

  const t0=performance.now();assert.equal(legacyScan('none','none'),null);const legacyMs=performance.now()-t0;
  const bridge=require('../dist/companion/remoteBridge.js');

  // 1. While the index is built (first requests after a restart): two submissions of one new step, at once.
  let watch=monitor();
  const fresh={taskId:'mcp:claude-chat:fresh',stepId:'only-once',method:'ping',params:{}};
  const [first,second]=await Promise.all([bridge.submitRemoteBridgeRequest({...fresh,requestId:'fresh-1'}),
    bridge.submitRemoteBridgeRequest({...fresh,requestId:'fresh-2'})]);
  const buildGap=watch.stop();
  assert.equal(first.requestId,'fresh-1');assert.equal(second.requestId,'fresh-1','the second submission returns the first receipt');
  assert.ok(!fs.existsSync(path.join(dir,'fresh-2.json')),'the step ran once');
  assert.ok(buildGap<250,`event loop free while ${fixture.files} receipts are indexed: longest pause ${buildGap.toFixed(0)} ms (legacy pass ${legacyMs.toFixed(0)} ms)`);

  // 2. Indexed lookups: a step of a previous instance is answered from its receipt, without a scan.
  watch=monitor();
  const replay=await bridge.submitRemoteBridgeRequest({requestId:'replay-1',taskId:'mcp:claude-chat:orange-app-surface-live',stepId:'share1',method:'ping',params:{}});
  const lookupGap=watch.stop();
  assert.equal(replay.requestId,'known-orange');assert.ok(!fs.existsSync(path.join(dir,'replay-1.json')));
  assert.ok(lookupGap<50,'no full pass per request: longest pause '+lookupGap.toFixed(0)+' ms');
  await assert.rejects(bridge.submitRemoteBridgeRequest({requestId:'conflict-1',taskId:'mcp:claude-chat:orange-app-surface-live',
    stepId:'share1',method:'process_status',params:{processId:'p'}}),error=>error.statusCode===409&&error.message==='task_step_conflict');

  // 3. task_status reads only the task's receipts, in order.
  const status=await bridge.submitRemoteBridgeRequest({requestId:'status-1',method:'task_status',params:{taskId:'mcp:claude-chat:multi'}});
  assert.equal(status.state,'completed');assert.equal(status.result.total,3);
  assert.deepEqual(status.result.receipts.map(r=>r.stepId),['a','b','c']);

  // 4. A receipt written after the build is found by the next submission of the same step.
  const later=await bridge.submitRemoteBridgeRequest({requestId:'later-1',taskId:'mcp:claude-chat:later',stepId:'s',method:'ping',params:{}});
  const laterAgain=await bridge.submitRemoteBridgeRequest({requestId:'later-2',taskId:'mcp:claude-chat:later',stepId:'s',method:'ping',params:{}});
  assert.equal(later.requestId,'later-1');assert.equal(laterAgain.requestId,'later-1');

  // 5. A receipt removed by the read retention is no longer a proof, exactly as with the former scan.
  fs.rmSync(path.join(dir,'later-1.json'));
  const afterPrune=await bridge.submitRemoteBridgeRequest({requestId:'later-3',taskId:'mcp:claude-chat:later',stepId:'s',method:'ping',params:{}});
  assert.equal(afterPrune.requestId,'later-3');
  console.log(`remote-bridge-receipt-index: PASS (${fixture.files} receipts; legacy synchronous pass ${legacyMs.toFixed(0)} ms, `+
    `longest event-loop pause while indexing ${buildGap.toFixed(0)} ms, per request ${lookupGap.toFixed(0)} ms; one execution per step)`);
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{fs.rmSync(root,{recursive:true,force:true});
  if(process.exitCode)process.exit(process.exitCode);});
