const {performance}=require('node:perf_hooks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samantha-r2-v2-'));
process.env.OPENCLAW_STATE_DIR = root;
const folder = path.join(root, 'clawmobile-companion');
fs.mkdirSync(folder);
const registry = path.join(folder, 'runs.json');
const owner = path.join(root, 'owner.sqlite');
const gateway = path.join(root, 'gateway.py');
const calls = path.join(root, 'calls.jsonl');
// Mock the owner API over an actual SQLite fixture, without legacy JSON files.
// The fixture schema is test-only; runtime code knows only Gateway contracts.
fs.writeFileSync(gateway, `#!/usr/bin/env python3
import json, sqlite3, sys
db=sqlite3.connect(${JSON.stringify(owner)})
method=sys.argv[3]
with open(${JSON.stringify(calls)},'a') as f: f.write(json.dumps(method)+'\\n')
row=db.execute('select response from responses where method=?',(method,)).fetchone()
if row is None: sys.exit(1)
print(row[0])
`);
fs.chmodSync(gateway, 0o700);
process.env.CLAWMOBILE_OPENCLAW_BIN = gateway;
const api = require('../dist/companion/runs');
const {expectedCompanionSessionKey} = require('../dist/companion/openclawAgentClient');
const now = Date.now(), old = now - 30 * 60 * 1000;
const run = (id, extra = {}) => ({decision:{version:2,type:'REASON',risk:'read'},runId: id, sessionId: id, text: 'Unique request ' + id,
  acceptedAt: old, updatedAt: old, state: 'running', executionSource: 'capability_first', ...extra});
const message = (role, content, timestamp, extra = {}) => ({role, content, timestamp, ...extra});
function write(run, payments = [], confirmations = []) {
  fs.writeFileSync(registry, JSON.stringify({version: 1, runs: [run], archivedSessionIds: [],
    paymentRequests: payments, ownerConfirmations: confirmations, runDeletions: []}));
}
function responses(values) {
  const result = spawnSync('python3', ['-c', `import sqlite3,json,sys
db=sqlite3.connect(sys.argv[1]); db.execute('create table if not exists responses(method text primary key,response text)'); db.execute('delete from responses')
for k,v in json.loads(sys.argv[2]).items(): db.execute('insert into responses values(?,?)',(k,json.dumps(v)))
db.commit()`, owner, JSON.stringify(values)], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}
function ownerProof(r, messages, extra = {}) {
  responses({'sessions.list': {sessions: [{key: expectedCompanionSessionKey(r.sessionId),
    hasActiveRun: false, activeRunIds: [], lastActivityAt: old, permissionModePending: false, abortedLastRun: false, ...extra}]}, 'chat.history': {messages}});
}
const stored = () => JSON.parse(fs.readFileSync(registry)).runs[0];
const callsCount = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
async function status(r) {return api.getRunStatus(r.runId);}

// No wall-clock sleep or polling. Owner replies still come through the real CLI
// subprocess and SQLite; only delivery latency and deadline time are injected.
const gatewayClient=require('../dist/companion/openclawAgentClient');const originalGateway=gatewayClient.callOpenClawGateway;
let entered=0,virtualNow=now,ownerLatency=null,holdHistory=null;
api.runInactivityClock.now=()=>virtualNow;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};}
function hold(){const started=deferred(),released=deferred();released.promise.catch(()=>{});holdHistory={started,released,options:null};return holdHistory;}
gatewayClient.callOpenClawGateway=(method,params,options)=>{
 entered++;if(ownerLatency){assert.equal(options.timeoutMs,method==='sessions.list'?10000:5850);assert.equal(options.hardTimeoutMs,options.timeoutMs);}const promise=originalGateway(method,params,options);
 const barrier=method==='chat.history'?holdHistory:null;
 if(barrier){barrier.options=options;barrier.started.resolve();}
 return promise.then(async value=>{
  if(barrier)await barrier.released.promise;
  virtualNow+=ownerLatency?.[method]||0;
  return value;
 });
};
async function idle(){await api.awaitRunInactivity();}
async function expire(r){const before=entered;const start=performance.now();const snapshot=await status(r);assert.equal(snapshot.state,'running');assert.ok(performance.now()-start<300,'read awaited owner');await idle();assert.equal(stored().error,'run_inactivity_expired');assert.ok(entered>before);return status(r);}
(async()=>{
 // Review regression: a recent Gateway run is updated immediately from its
 // live session/history, without waiting ten minutes for inactivity evidence.
 let recent=run('recent-complete',{executionSource:'gateway',acceptedAt:now-30000,updatedAt:now-30000});write(recent);
 ownerProof(recent,[message('user',recent.text,now-30000),message('assistant','Recent canonical result',now-1000,{stopReason:'stop'})],{sessionId:'recent-owner-session',status:'done',lastActivityAt:now-1000});
 let fresh=await status(recent);assert.equal(fresh.state,'done');assert.equal(fresh.result,'Recent canonical result');assert.equal(stored().result,'Recent canonical result');assert.equal(fresh.inactivityCorrectionReceipt,undefined);await idle();
 // The list refreshes run by run, including the canonical history fallback
 // when SQLite replaced local JSONL transcripts.
 recent=run('recent-list',{executionSource:'gateway',acceptedAt:now-30000,updatedAt:now-30000});write(recent);
 ownerProof(recent,[message('user',recent.text,now-30000),message('assistant','Recent list result',now-1000,{stopReason:'stop'})],{sessionId:'recent-list-owner',status:'done',lastActivityAt:now-1000});fresh=(await api.listRuns())[0];assert.equal(fresh.state,'done');assert.equal(fresh.result,'Recent list result');await idle();
 // Required 1: no readable owner/SQLite proof never expires; no sessions.json.
 let r=run('no-proof');write(r);responses({});assert.equal((await status(r)).state,'running');await idle();assert.equal(stored().error,undefined);assert.equal(fs.existsSync(path.join(root,'agents/main/sessions/sessions.json')),false);
 // Replay measured S24 4.15s + 2.39s latency on the injected clock, without wall time.
 ownerLatency={'sessions.list':4150,'chat.history':2390};
 r=run('slow-expiry');write(r);ownerProof(r,[message('user',r.text,old)]);let before=entered,start=virtualNow,readStart=performance.now();
 const snapshots=await Promise.all(Array.from({length:6},()=>status(r)));assert.ok(snapshots.every(x=>x.state==='running'));assert.ok(performance.now()-readStart<300);
 await idle();assert.equal(stored().error,'run_inactivity_expired');assert.equal(entered-before,2,'one sessions/history pass for concurrent reads');assert.equal(virtualNow-start,6540);
 before=entered;await Promise.all([status(r),api.listRuns(),api.listRunSummaries()]);await idle();assert.equal(entered,before,'expired run is retired from polling');ownerLatency=null;
 // Required 3: a late canonical callback replaces expiration and has a receipt.
 await api.settleSubmittedRun(r.runId,'done','Real late result');let result=await status(r);assert.equal(result.result,'Real late result');assert.equal(result.inactivityCorrectionReceipt.to,'done');
 const receipt=result.inactivityCorrectionReceipt;assert.deepEqual(stored().inactivityCorrectionReceipt,receipt);
 const restarted=spawnSync(process.execPath,['-e',`require('./dist/companion/runs').getRunStatus('slow-expiry').then(r=>console.log(JSON.stringify(r)))`],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.equal(restarted.status,0,restarted.stderr);assert.deepEqual(JSON.parse(restarted.stdout).inactivityCorrectionReceipt,receipt);
 // Existing explicit conversation-history read supplies late turn evidence,
 // without putting expired runs back in the automatic candidate pool.
 r=run('late-history',{executionSource:'gateway'});write(r);ownerProof(r,[message('user',r.text,old)]);await expire(r);
 ownerProof(r,[message('user',r.text,old),message('assistant','History late result',now-1000,{stopReason:'stop'})]);
 const rows=await api.getConversationTurns(r.sessionId);assert.equal(rows[0].result,'History late result');assert.equal(rows[0].inactivityCorrectionReceipt.to,'done');await idle();
 // Required 2: outstanding tools remain active, even with old session flags.
 r=run('long-tool');write(r);ownerProof(r,[message('user',r.text,old),message('assistant',[{type:'toolCall',id:'tool-1',name:'legitimate'}],old+1000)]);assert.equal((await status(r)).state,'running');await idle();assert.equal(stored().error,undefined);
 // Required 4: protected runs never enter the pool, regardless of origin IDs.
 for(const [id,payments,confirmations,decision] of [
  ['legacy-unqualified',[],[],undefined],
  ['bank',[{state:'requires_bank_action',ownerConfirmationId:'canonical-confirm',draft:{origin:{id:'foreign'}}}],[],undefined],
  ['biometric',[],[{id:'canonical-confirm',state:'awaiting_owner',intent:{origin:{id:'foreign'}}}],undefined],
  ['capability',[],[],{version:2,capability_id:'payment.topup'}],
  ['nested',[],[],{version:2,selected:{capability:'payment.topup'},confirmationRequired:false}],
  ['human',[],[],{version:2,humanBoundary:'owner_biometric'}],
  ['unknown-guard',[{id:'unknown'}],[],undefined]]){
   r=run(id,{decision});write(r,payments,confirmations);ownerProof(r,[message('user',r.text,old)]);before=entered;assert.equal((await status(r)).state,'running');await idle();assert.equal(entered,before);assert.deepEqual(JSON.parse(fs.readFileSync(registry)).paymentRequests,payments);assert.deepEqual(JSON.parse(fs.readFileSync(registry)).ownerConfirmations,confirmations);
 }
 for(const [id,make,flags] of [
  ['unknown',r=>[message('user',r.text,old)],{hasActiveRun:null}],
  ['recent',r=>[message('user',r.text,old),message('assistant','working',now-1000)],{}],
  ['duplicate',r=>[message('user',r.text,old),message('user',r.text,old+1000)],{}],
  ['undated',r=>[message('user',r.text,undefined)],{}],
  ['old-turn',r=>[message('user',r.text,old-60000)],{}],
  ['active',r=>[message('user',r.text,old)],{hasActiveRun:true}],
  ['status-running',r=>[message('user',r.text,old)],{status:'running'}],
  ['seconds',r=>[message('user',r.text,old)],{lastActivityAt:Math.floor(old/1000)}],
  ['permission',r=>[message('user',r.text,old)],{permissionModePending:true}]]){
   r=run(id);write(r);ownerProof(r,make(r),flags);assert.equal((await status(r)).state,'running');await idle();assert.equal(stored().error,undefined,id);
 }
 // M1: session-level activity / another run never resurrects an expired run.
 for(const ids of [['another-run'],['retired']]){
  const retired=run('retired',{state:'failed',error:'run_inactivity_expired'}),peer=run('peer',{sessionId:'retired'});write(retired);let reg=JSON.parse(fs.readFileSync(registry));reg.runs.push(peer);fs.writeFileSync(registry,JSON.stringify(reg));ownerProof(peer,[],{hasActiveRun:true,activeRunIds:ids});
  await status(peer);await idle();
  const changed=JSON.parse(fs.readFileSync(registry)).runs.find(x=>x.runId==='retired');assert.equal(changed.state,ids.includes('retired')?'running':'failed');if(ids.includes('retired'))assert.equal(changed.inactivityCorrectionReceipt.to,'running');
 }
 // When owner run ids differ, an explicitly read, unique turn can prove activity.
 r=run('turn-active',{state:'failed',error:'run_inactivity_expired',executionSource:'gateway'});write(r);ownerProof(r,[message('user',r.text,old),message('assistant',[{type:'toolCall',id:'active-tool',name:'legitimate'}],old+1000)],{hasActiveRun:true,activeRunIds:['foreign-owner-id']});
 assert.equal((await status(r)).status,'expired');await idle();const activeTurns=await api.getConversationTurns(r.sessionId);assert.equal(activeTurns[0].state,'running');assert.equal(activeTurns[0].inactivityCorrectionReceipt.to,'running');await idle();
 // A formerly corrected run expiring again cannot carry a stale running receipt.
 r=run('re-expire',{inactivityCorrectionReceipt:{version:1,action:'correct_run_expiration',runId:'re-expire',from:'expired',to:'running',at:old,evidenceAt:old}});write(r);ownerProof(r,[message('user',r.text,old)]);await expire(r);assert.equal(stored().inactivityCorrectionReceipt,undefined);
 // Background evidence must lose to concurrent deletion/archive/result/guard/failure.
 for(const mutation of ['delete','archive','result','failure','guard']){
  r=run('race-'+mutation);write(r);ownerProof(r,[message('user',r.text,old)]);const barrier=hold();const snapshot=await status(r);assert.equal(snapshot.state,'running');await barrier.started.promise;
  if(mutation==='delete')await api.deleteSession(r.sessionId);
  if(mutation==='archive')await api.archiveSession(r.sessionId);
  if(mutation==='result')await api.settleSubmittedRun(r.runId,'done','Concurrent real result');
  if(mutation==='failure')await api.markSubmittedRunFailed(r.runId,'Definitive failure');
  if(mutation==='guard'){const value=JSON.parse(fs.readFileSync(registry));value.ownerConfirmations=[{state:'awaiting_owner',intent:{origin:{id:'foreign'}}}];fs.writeFileSync(registry,JSON.stringify(value));}
  barrier.released.resolve();await idle();holdHistory=null;const value=JSON.parse(fs.readFileSync(registry));if(mutation==='delete')assert.equal(value.runs.length,0);if(mutation==='archive')assert.deepEqual(value.archivedSessionIds,[r.sessionId]);if(mutation==='result')assert.equal(value.runs[0].result,'Concurrent real result');if(mutation==='failure')assert.equal(value.runs[0].error,'Definitive failure');if(['archive','guard'].includes(mutation))assert.equal(value.runs[0].state,'running');
 }
 // A held owner reply observes the exact global deadline passed to the CLI.
 r=run('budget-timeout');write(r);ownerProof(r,[message('user',r.text,old)]);const barrier=hold();start=virtualNow;readStart=performance.now();assert.equal((await status(r)).state,'running');assert.ok(performance.now()-readStart<300);await barrier.started.promise;
 assert.equal(barrier.options.timeoutMs,10000);assert.equal(barrier.options.hardTimeoutMs,10000);
 virtualNow+=barrier.options.hardTimeoutMs;barrier.released.reject(new Error('inactivity_read_budget_exceeded'));await idle();holdHistory=null;
 assert.equal(virtualNow-start,10000);assert.equal(stored().error,undefined);
 fs.writeFileSync(registry,'{bad registry');responses({});assert.equal((await api.getRunStatus('missing')).state,'unknown');await idle();
 console.log(JSON.stringify({suite:'R2-v2',passed:true,required:{noReadableProof:'passed',longActiveTool:'passed',lateResult:'passed',bankBiometricDifferentOrigins:'passed'},recentGatewayCompletion:'passed',recentLiveList:'passed',singleFlightBackground:'passed',deterministicOwnerLatency:'passed',backgroundDeadline:'passed',sqliteCliTransport:'passed',expiredPoolRetired:'passed',runScopedResurrection:'passed',concurrentMutations:'passed'}));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{api.runInactivityClock.now=()=>Date.now();gatewayClient.callOpenClawGateway=originalGateway;fs.rmSync(root,{recursive:true,force:true});});
