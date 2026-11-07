// S24 07/11 19:14: release 888daa93 rolled back because /files?scope=session was still "deferred" after the settle window,
// as on 07/11 14:05 and 05/11 23:02. The session listing confirms the main session (sessions.list, 6.5 s through the CLI on
// the S24 at rest) and then lists its files (3.5-6 s) one after the other, under one 13.5 s read deadline.
// Real capture: fixtures/s24-2026-11-07-files-session-deferred/rollbacks-and-cli-timing.json.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-11-07-files-session-deferred/rollbacks-and-cli-timing.json'),'utf8'));
const captured=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/r20/sessions.list.main.json'),'utf8')).response;
const others=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/gateway/sessions.list.json'),'utf8')).response;
const main=captured.sessions[0];

// The captured CLI durations, scaled down ten times for the CI.
const [listCall,secondCall]=fixture.cliTimingAtRest.calls;
const LIST_MS=Math.round(listCall.seconds*100),FILES_MS=Math.round(secondCall.seconds*100);
let calls=[],mode='ok';
require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params)=>{
  calls.push(method);
  if(method==='sessions.list'){
    assert.deepEqual(params,{search:'agent:main:main',limit:100});
    await new Promise(r=>setTimeout(r,LIST_MS));
    if(mode==='down')throw Object.assign(new Error('gateway_unavailable'),{code:'ECONNREFUSED'});
    return mode==='absent'?others:captured;
  }
  assert.equal(method,'sessions.files.list');assert.equal(params.sessionKey,main.key);
  await new Promise(r=>setTimeout(r,FILES_MS));
  return {sessionKey:params.sessionKey,root:'/fixture/workspace',files:[],browser:{path:params.path,entries:[{name:'note.md',path:'note.md',kind:'file'}],truncated:false}};
};
function fresh(){
  for(const key of Object.keys(require.cache))if(/[\\/]dist[\\/]companion[\\/](fileReads|control)\.js$/.test(key))delete require.cache[key];
  calls=[];return require('../dist/companion/fileReads.js');
}
async function settle(files){ // the acceptance contract: 200 + "deferred" until the read has its answer
  const started=Date.now();
  for(;;){
    let value;try{value=await files.filesList(new URLSearchParams('scope=session'));}catch(error){return {error,ms:Date.now()-started};}
    if(value?.computation?.deliveryMode!=='deferred')return {value,ms:Date.now()-started};
    await new Promise(r=>setTimeout(r,10));
  }
}
const idle=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  // The capture: three rollbacks on the session listing, and two CLI calls that nearly fill the read deadline at rest.
  assert.equal(fixture.rollbacks.length,3);
  for(const rollback of fixture.rollbacks){
    assert.equal(rollback.state,'rolled_back');assert.equal(rollback.detail,'acceptance_failed');
    const row=rollback.failing.find(r=>r.route==='/files?scope=session');
    assert.ok(row&&row.code===200&&row.settled===false,'200 in budget, never settled: '+rollback.receipt);
  }
  assert.equal(fixture.rollbacks[0].failing[0].settledLate,true,'the late re-judgment failed too');
  const pair=(listCall.seconds+secondCall.seconds)*1000;
  assert.ok(pair>10000&&pair<fixture.acceptance.readDeadlineMs,'two CLI calls: '+pair+' ms of a '+fixture.acceptance.readDeadlineMs+' ms deadline, at rest');
  assert.ok(secondCall.seconds*1000<fixture.acceptance.readDeadlineMs/3,'one call alone leaves a wide margin');

  // Before: a cold read pays both calls in a row.
  let files=fresh();const cold=await settle(files);
  assert.ok(cold.value?.success,'cold read answers');
  assert.deepEqual(calls,['sessions.list','sessions.files.list']);
  assert.ok(cold.ms>=LIST_MS+FILES_MS-20,'cold read: both calls in a row ('+cold.ms+' ms)');

  // After: the startup prewarm confirms the main session; the first read needs only the files call.
  files=fresh();files.prewarmFileMainSession();files.prewarmFileMainSession();
  await idle(LIST_MS+40);
  assert.deepEqual(calls,['sessions.list'],'one confirmation, no files RPC from the prewarm');
  const warm=await settle(files);
  assert.ok(warm.value?.success);assert.equal(warm.value.items.length,1);
  assert.deepEqual(calls,['sessions.list','sessions.files.list'],'the read reused the confirmed row');
  assert.ok(warm.ms<LIST_MS,'first read after the prewarm: one call ('+warm.ms+' ms, cold '+cold.ms+' ms)');

  // A read that arrives while the prewarm is still asking joins it instead of asking again.
  files=fresh();files.prewarmFileMainSession();await idle(LIST_MS/2);
  const joined=await settle(files);assert.ok(joined.value?.success);
  assert.deepEqual(calls,['sessions.list','sessions.files.list']);

  // A Gateway that cannot answer at startup is not remembered: the next read asks again and succeeds.
  files=fresh();mode='down';files.prewarmFileMainSession();await idle(LIST_MS+40);mode='ok';
  const recovered=await settle(files);
  assert.ok(recovered.value?.success,'no negative cache from the prewarm');
  assert.deepEqual(calls,['sessions.list','sessions.list','sessions.files.list']);

  // No main row: still fail closed, and never a files RPC without the confirmed owner key.
  files=fresh();mode='absent';files.prewarmFileMainSession();await idle(LIST_MS+40);
  const absent=await settle(files);
  assert.equal(absent.error?.statusCode,503);assert.equal(absent.error?.message,'files_owner_unavailable');
  assert.ok(!calls.includes('sessions.files.list'),'no files RPC without the main row');
  assert.deepEqual(calls,['sessions.list','sessions.list'],'an empty prewarm answer is not kept either');
  mode='ok';

  // The Companion schedules the prewarm at startup, after the bridge sweep.
  const server=fs.readFileSync(path.join(__dirname,'../src/companion/server.ts'),'utf8');
  const start=server.indexOf('export function startCompanionServer('),end=server.indexOf('\n  return server;\n}',start);
  assert.ok(start>0&&end>start);
  assert.match(server.slice(start,end),/setTimeout\(\(\) => prewarmFileMainSession\(\), 1_000\)\.unref\(\);/);
  console.log(`files-main-session-prewarm: PASS (S24 capture scaled 1/10: cold read ${cold.ms} ms with two calls, `+
    `first read after the prewarm ${warm.ms} ms with one; failures and absent rows are not kept; no files RPC without the main row)`);
})().catch(error=>{console.error(error);process.exitCode=1});
