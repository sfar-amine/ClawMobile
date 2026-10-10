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
const block = path.join(root, 'block'), started = path.join(root, 'started'), release = path.join(root, 'release');
// Mock the owner API over an actual SQLite fixture, without legacy JSON files.
// The fixture schema is test-only; runtime code knows only Gateway contracts.
fs.writeFileSync(gateway, `#!/usr/bin/env python3
import json, sqlite3, sys, os, time
db=sqlite3.connect(${JSON.stringify(owner)})
method=sys.argv[3]
if method=='chat.history' and os.path.exists(${JSON.stringify(block)}):
 open(${JSON.stringify(started)},'w').close()
 while not os.path.exists(${JSON.stringify(release)}): time.sleep(0.01)
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
const run = (id, extra = {}) => ({runId: id, sessionId: id, text: 'Unique request ' + id,
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

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,timeout=3000){const start=Date.now();while(!test()){assert.ok(Date.now()-start<timeout,'background condition timed out');await delay(10);}}
// Observe the real CLI promises, without exposing a production test API.
const gatewayClient=require('../dist/companion/openclawAgentClient');const originalGateway=gatewayClient.callOpenClawGateway;const inflight=new Set();let entered=0;
gatewayClient.callOpenClawGateway=(...args)=>{entered++;const promise=originalGateway(...args);inflight.add(promise);promise.then(()=>inflight.delete(promise),()=>inflight.delete(promise));return promise;};
async function idle(){await delay(40);while(inflight.size){await Promise.allSettled([...inflight]);await delay(40);}}
async function expire(r){const before=entered;const start=Date.now();const snapshot=await status(r);assert.equal(snapshot.state,'running');assert.ok(Date.now()-start<300,'read awaited owner');await until(()=>stored().error==='run_inactivity_expired',10000);await idle();assert.ok(entered>before);return status(r);}
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
 // Positive negative-proof test with real S24-like 4.15s + 2.39s CLI latency.
 const originalScript=fs.readFileSync(gateway,'utf8');fs.writeFileSync(gateway,originalScript.replace("method=sys.argv[3]","method=sys.argv[3]\ntime.sleep(4.15 if method=='sessions.list' else 2.39)"));
 r=run('slow-expiry');write(r);ownerProof(r,[message('user',r.text,old)]);let before=entered,start=Date.now();
 const snapshots=await Promise.all(Array.from({length:6},()=>status(r)));assert.ok(snapshots.every(x=>x.state==='running'));assert.ok(Date.now()-start<300);
 await until(()=>stored().error==='run_inactivity_expired',10000);await idle();assert.equal(entered-before,2,'one sessions/history pass for concurrent reads');assert.ok(Date.now()-start>=6500);
 before=entered;await Promise.all([status(r),api.listRuns(),api.listRunSummaries()]);await idle();assert.equal(entered,before,'expired run is retired from polling');fs.writeFileSync(gateway,originalScript);
 // Required 3: a late canonical callback replaces expiration and has a receipt.
 await api.settleSubmittedRun(r.runId,'done','Real late result');let result=await status(r);assert.equal(result.result,'Real late result');assert.equal(result.inactivityCorrectionReceipt.to,'done');
 const receipt=result.inactivityCorrectionReceipt;assert.deepEqual(stored().inactivityCorrectionReceipt,receipt);
 const restarted=spawnSync(process.execPath,['-e',`require('./dist/companion/runs').getRunStatus('slow-expiry').then(r=>console.log(JSON.stringify(r)))`],{encoding:'utf8'});assert.equal(restarted.status,0,restarted.stderr);assert.deepEqual(JSON.parse(restarted.stdout).inactivityCorrectionReceipt,receipt);
 // Existing explicit conversation-history read supplies late turn evidence,
 // without putting expired runs back in the automatic candidate pool.
 r=run('late-history',{executionSource:'gateway'});write(r);ownerProof(r,[message('user',r.text,old)]);await expire(r);
 ownerProof(r,[message('user',r.text,old),message('assistant','History late result',now-1000,{stopReason:'stop'})]);
 const rows=await api.getConversationTurns(r.sessionId);assert.equal(rows[0].result,'History late result');assert.equal(rows[0].inactivityCorrectionReceipt.to,'done');await idle();
 // Required 2: outstanding tools remain active, even with old session flags.
 r=run('long-tool');write(r);ownerProof(r,[message('user',r.text,old),message('assistant',[{type:'toolCall',id:'tool-1',name:'legitimate'}],old+1000)]);assert.equal((await status(r)).state,'running');await idle();assert.equal(stored().error,undefined);
 // Required 4: protected runs never enter the pool, regardless of origin IDs.
 for(const [id,payments,confirmations,decision] of [
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
  await status(peer);await idle();const changed=JSON.parse(fs.readFileSync(registry)).runs.find(x=>x.runId==='retired');assert.equal(changed.state,ids.includes('retired')?'running':'failed');if(ids.includes('retired'))assert.equal(changed.inactivityCorrectionReceipt.to,'running');
 }
 // When owner run ids differ, an explicitly read, unique turn can prove activity.
 r=run('turn-active',{state:'failed',error:'run_inactivity_expired',executionSource:'gateway'});write(r);ownerProof(r,[message('user',r.text,old),message('assistant',[{type:'toolCall',id:'active-tool',name:'legitimate'}],old+1000)],{hasActiveRun:true,activeRunIds:['foreign-owner-id']});
 assert.equal((await status(r)).status,'expired');await idle();const activeTurns=await api.getConversationTurns(r.sessionId);assert.equal(activeTurns[0].state,'running');assert.equal(activeTurns[0].inactivityCorrectionReceipt.to,'running');await idle();
 // A formerly corrected run expiring again cannot carry a stale running receipt.
 r=run('re-expire',{inactivityCorrectionReceipt:{version:1,action:'correct_run_expiration',runId:'re-expire',from:'expired',to:'running',at:old,evidenceAt:old}});write(r);ownerProof(r,[message('user',r.text,old)]);await expire(r);assert.equal(stored().inactivityCorrectionReceipt,undefined);
 // Background evidence must lose to concurrent deletion/archive/result/guard/failure.
 for(const mutation of ['delete','archive','result','failure','guard']){
  r=run('race-'+mutation);write(r);ownerProof(r,[message('user',r.text,old)]);for(const f of [started,release])try{fs.unlinkSync(f)}catch{}fs.writeFileSync(block,'block');const snapshot=await status(r);assert.equal(snapshot.state,'running');await until(()=>fs.existsSync(started));
  if(mutation==='delete')await api.deleteSession(r.sessionId);
  if(mutation==='archive')await api.archiveSession(r.sessionId);
  if(mutation==='result')await api.settleSubmittedRun(r.runId,'done','Concurrent real result');
  if(mutation==='failure')await api.markSubmittedRunFailed(r.runId,'Definitive failure');
  if(mutation==='guard'){const value=JSON.parse(fs.readFileSync(registry));value.ownerConfirmations=[{state:'awaiting_owner',intent:{origin:{id:'foreign'}}}];fs.writeFileSync(registry,JSON.stringify(value));}
  fs.writeFileSync(release,'release');await idle();fs.unlinkSync(block);const value=JSON.parse(fs.readFileSync(registry));if(mutation==='delete')assert.equal(value.runs.length,0);if(mutation==='archive')assert.deepEqual(value.archivedSessionIds,[r.sessionId]);if(mutation==='result')assert.equal(value.runs[0].result,'Concurrent real result');if(mutation==='failure')assert.equal(value.runs[0].error,'Definitive failure');if(['archive','guard'].includes(mutation))assert.equal(value.runs[0].state,'running');
 }
 // A hung CLI is killed by the global background budget, not by a read.
 r=run('budget-timeout');write(r);ownerProof(r,[message('user',r.text,old)]);for(const f of [started,release])try{fs.unlinkSync(f)}catch{}fs.writeFileSync(block,'block');start=Date.now();assert.equal((await status(r)).state,'running');assert.ok(Date.now()-start<300);await until(()=>fs.existsSync(started));await until(()=>inflight.size===0,11000);await idle();assert.ok(Date.now()-start>=9000&&Date.now()-start<11000);assert.equal(stored().error,undefined);fs.unlinkSync(block);
 fs.writeFileSync(registry,'{bad registry');responses({});assert.equal((await api.getRunStatus('missing')).state,'unknown');await idle();
 console.log(JSON.stringify({suite:'R2-v2',passed:true,required:{noReadableProof:'passed',longActiveTool:'passed',lateResult:'passed',bankBiometricDifferentOrigins:'passed'},recentGatewayCompletion:'passed',recentLiveList:'passed',singleFlightBackground:'passed',realisticLatency:'passed',expiredPoolRetired:'passed',runScopedResurrection:'passed',concurrentMutations:'passed'}));
})().catch(error=>{console.error(error);process.exitCode=1});
