// S24 07/11 16:07: « mon solde orange » shared from the app at home was refused by the Orange guard
// (orange_cellular_required_wifi_kept) because every app typed call carried the live-voice surface « claw_live ».
// Real capture: fixtures/s24-2026-11-07-orange-app-surface/run-and-guard.json (status served by Companion 1bf6ca93,
// the guard refusal recorded in route-health, the execution-graph surface kinds).
// S24 07/11 17:54 (after core#563): same refusal. The registry row was a written app turn, but the HTTP run lookup
// of 1.5 s fell back to « claw_live » while the Companion answered nothing for ~40 s of a long turn.
// Real capture: fixtures/s24-2026-11-07-orange-app-surface/registry-and-busy-companion.json.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'typed-app-surface-'));
process.env.OPENCLAW_STATE_DIR=root;
const dir=path.join(__dirname,'../fixtures/s24-2026-11-07-orange-app-surface');
const fixture=JSON.parse(fs.readFileSync(path.join(dir,'run-and-guard.json'),'utf8'));
const busy=JSON.parse(fs.readFileSync(path.join(dir,'registry-and-busy-companion.json'),'utf8'));
const guard=require('../dist/capabilityAgentGuard.js');
const tools=require('../dist/typedCapabilityTools.js');
const runs=require('../dist/companion/runs.js');
const registry=path.join(root,'clawmobile-companion/runs.json');

function writeRegistry(rows){fs.mkdirSync(path.dirname(registry),{recursive:true});
  fs.writeFileSync(registry,JSON.stringify({version:1,runs:rows,archivedSessionIds:[]}));}
function listen(handler){return new Promise(resolve=>{const server=http.createServer(handler);
  server.listen(0,'127.0.0.1',()=>resolve(server));});}
async function timed(id){const t0=Date.now();const surface=await tools.typedOwnerGraphSurface(id);return {surface,ms:Date.now()-t0};}

async function main(){
  // 16:07 capture: the live-voice restriction, not a network failure of the read itself.
  const refusal=fixture.routeHealth['maxit-tunisie|telecom.orange.balances|orange.balances.ussd.v1'].history[0].summary;
  assert.match(refusal,/orange_cellular_required_wifi_kept/);assert.match(refusal,/'wifi_disabled': False/);
  assert.equal(fixture.executionGraphSurfaces.claw_live.kind,'voice');
  assert.equal(fixture.executionGraphSurfaces.samantha_android.kind,'app');

  // 17:54 capture: the row was right, the decision still carried claw_live, and the Companion went silent mid-turn.
  const row=busy.registryRow,runId=row.runId;
  assert.equal(row.userText,'mon solde orange');assert.equal(row.voiceDelegation_present,false);
  assert.equal(row.executionSource,'gateway');assert.ok(!row.row_keys.includes('voiceDelegation'));
  assert.equal(busy.dialogueDecision['decision.plan.typedTool.userRunId'],runId,'the typed call was bound to this exact run');
  assert.equal(busy.dialogueDecision['decision.surface'],'claw_live','yet it carried the live-voice surface');
  assert.equal(busy.dialogueDecision['decision.selected.route'],'orange.balances.ussd.v1');
  assert.match(busy.routeHealth[1].summary,/orange_cellular_required_wifi_kept/);
  assert.match(busy.routeHealth[1].summary,/'wifi_disabled': False/);
  const lines=busy.probeLongTurn.filter(line=>/^\d\d:\d\d:\d\d\.\d+ /.test(line)).map(line=>line.split(' '));
  assert.ok(lines.slice(0,6).every(([,code,s])=>code==='200'&&Number(s)<0.5),'answered fast before the long turn');
  const silent=lines.filter(([,code,s])=>code==='000'&&Number(s)>=3);
  assert.ok(silent.length>=10,'then no answer within 3 s for '+silent.length+' polls (about 40 s)');
  assert.ok(busy.probeShortTurn.filter(line=>/ 200 /.test(line)).length>=10,'a short turn stayed responsive: intermittent');
  assert.ok(busy.registryFile.bytes>1000000&&busy.registryFile.runs===386);

  // The real row, as the Companion stored it before the turn, plus a Samantha Voix hand-over and S24-sized history.
  const stored={runId,clientRunId:row.clientRunId,sessionId:row.sessionId,acceptedAt:row.acceptedAt,updatedAt:row.updatedAt,
    state:'running',executionSource:'gateway',ownerAdmitted:true,ownerTransport:'admin_admitted',semanticOwner:'main',
    userText:row.userText,text:row.userText};
  const voice={...stored,runId:'run_1794070500000_aaaaaaaa',clientRunId:'samantha-voice-0001',voiceDelegation:true};
  const history=Array.from({length:384},(_,i)=>({...stored,runId:'run_17940'+String(i).padStart(8,'0')+'_bbbbbbbb',
    state:'done',result:'x'.repeat(2400)}));
  writeRegistry([voice,stored,...history]);
  assert.ok(fs.statSync(registry).size>1000000,'S24-sized registry');

  // A Companion that answers nothing (17:54) is never asked: the registry row decides.
  const sockets=new Set();
  const silentCompanion=await listen(()=>{});silentCompanion.unref();
  silentCompanion.on('connection',socket=>sockets.add(socket));
  process.env.CLAWMOBILE_COMPANION_PORT=String(silentCompanion.address().port);
  let r=await timed(runId);
  assert.equal(r.surface,'samantha_android','written app turn → app surface even while the Companion is silent');
  assert.ok(r.ms<1000,'no wait on the Companion ('+r.ms+' ms)');
  assert.equal(sockets.size,0,'no HTTP request to the Companion');
  assert.equal((await timed(voice.runId)).surface,'claw_live','a Samantha Voix hand-over never turns Wi-Fi off');
  assert.equal((await timed('run_unknown_00000000')).surface,'claw_live','unknown run keeps the restriction');
  assert.equal((await timed('bad id/../x')).surface,'claw_live');
  for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>silentCompanion.close(resolve));

  // The brain's typed Orange call from this app turn reaches the graph with the app surface.
  const views=path.join(root,'.openclaw/capability-views');fs.mkdirSync(views,{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'),path.join(views,'agent-tools.json'));
  const helper=path.join(root,'helper.py');
  fs.writeFileSync(helper,"import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({'state':'COMPLETED','received':p}))\n");
  const ctx={senderIsOwner:true,agentId:'main',sessionKey:'agent:main:companion-chat-'+row.sessionId,sessionId:'s',
    assertInvocationCurrent(){}};
  const orange=tools.createTypedCapabilityTools(ctx,{home:root,helperPath:helper}).find(t=>t.name==='samantha_maxit_tunisie');
  const args={action:'telecom.orange.balances',params:{}};
  const call=async(id,run)=>{guard.agentCapabilityHook({toolName:orange.name,params:args,toolCallId:id},
    {requester:{senderIsOwner:true},agentId:'main',runId:run,sessionKey:ctx.sessionKey,sessionId:'s'});
    return JSON.parse((await orange.execute(id,args)).content[0].text).received.host;};
  let host=await call('call-app',runId);
  assert.equal(host.graphSurface,'samantha_android');assert.equal(host.surface,'app');assert.equal(host.userRunId,runId);
  host=await call('call-voice',voice.runId);assert.equal(host.graphSurface,'claw_live');

  // An unreadable registry keeps the restriction: corrupt, oversized, missing.
  fs.writeFileSync(registry,'{"runs":[');assert.equal((await timed(runId)).surface,'claw_live','corrupt registry');
  fs.writeFileSync(registry,'');fs.truncateSync(registry,16*1024*1024+1);
  assert.equal((await timed(runId)).surface,'claw_live','oversized registry is not parsed');
  fs.rmSync(registry);assert.equal((await timed(runId)).surface,'claw_live','missing registry');
  host=await call('call-down',runId);assert.equal(host.graphSurface,'claw_live','no registry keeps the restriction');

  // Companion side: the real writer records a Samantha Voix hand-over, and the reader agrees with it, before and after reload.
  const voiceRun=await runs.reserveSubmittedRun('mon solde orange','voice-session','voice-client-0001',{executionSource:'gateway',voiceDelegation:true});
  const written=await runs.reserveSubmittedRun('mon solde orange','app-session','app-client-0001',{executionSource:'gateway'});
  assert.equal((await runs.getRunStatus(voiceRun.status.runId)).turnOrigin,'voice');
  assert.equal((await runs.getRunStatus(written.status.runId)).turnOrigin,'app');
  const persisted=JSON.parse(fs.readFileSync(registry,'utf8')).runs;
  assert.equal(persisted.find(r=>r.runId===voiceRun.status.runId).voiceDelegation,true);
  assert.equal(persisted.find(r=>r.runId===written.status.runId).voiceDelegation,undefined);
  assert.equal((await timed(written.status.runId)).surface,'samantha_android','row written at reservation, before the turn');
  assert.equal((await timed(voiceRun.status.runId)).surface,'claw_live');
  for(const key of Object.keys(require.cache))if(key.includes(`${path.sep}dist${path.sep}companion${path.sep}`))delete require.cache[key];
  const reloaded=require('../dist/companion/runs.js');
  assert.equal((await reloaded.getRunStatus(voiceRun.status.runId)).turnOrigin,'voice');
  assert.equal((await reloaded.getRunStatus(written.status.runId)).turnOrigin,'app');
  console.log('typed-app-surface: PASS (written app turn → app surface from the registry row, even with a silent Companion; '+
    'Samantha Voix, unknown runs and unreadable registries keep the live-voice restriction)');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{fs.rmSync(root,{recursive:true,force:true});
  if(process.exitCode)process.exit(process.exitCode);});
