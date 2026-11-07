// S24 07/11 16:07: « mon solde orange » shared from the app at home was refused by the Orange guard
// (orange_cellular_required_wifi_kept) because every app typed call carried the live-voice surface « claw_live ».
// Real capture: fixtures/s24-2026-11-07-orange-app-surface/run-and-guard.json (status served by Companion 1bf6ca93,
// the guard refusal recorded in route-health, the execution-graph surface kinds).
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'typed-app-surface-'));
process.env.OPENCLAW_STATE_DIR=root;
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-11-07-orange-app-surface/run-and-guard.json'),'utf8'));
const guard=require('../dist/capabilityAgentGuard.js');
const tools=require('../dist/typedCapabilityTools.js');
const runs=require('../dist/companion/runs.js');

function listen(handler){return new Promise(resolve=>{const server=http.createServer(handler);
  server.listen(0,'127.0.0.1',()=>resolve(server));});}
async function main(){
  const real=fixture.runStatus,runId=real.runId;
  // The captured refusal is the live-voice restriction, not a network failure of the read itself.
  const refusal=fixture.routeHealth['maxit-tunisie|telecom.orange.balances|orange.balances.ussd.v1'].history[0].summary;
  assert.match(refusal,/orange_cellular_required_wifi_kept/);assert.match(refusal,/'wifi_disabled': False/);
  assert.equal(fixture.executionGraphSurfaces.claw_live.kind,'voice');
  assert.equal(fixture.executionGraphSurfaces.samantha_android.kind,'app');
  assert.equal(real.userText,'mon solde orange');assert.equal(real.turnMeasurement.surface,'app');
  assert.equal(real.turnOrigin,undefined,'the deployed Companion did not say where the run came from');

  let mode='deployed';
  const server=await listen((req,res)=>{
    const id=decodeURIComponent((req.url||'').replace(/^\/v1\/runs\//,''));
    if(req.method!=='GET'||id!==runId||mode==='missing'){res.writeHead(404,{'content-type':'application/json'});
      return res.end(JSON.stringify({success:false,state:'unknown',runId:id}));}
    const body=mode==='deployed'?real:mode==='other'?{...real,runId:'run_other',turnOrigin:'app'}:{...real,turnOrigin:mode};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));
  });
  process.env.CLAWMOBILE_COMPANION_PORT=String(server.address().port);
  const surface=()=>tools.typedOwnerGraphSurface(runId);
  assert.equal(await surface(),'claw_live','unproven origin keeps the live-voice restriction');
  mode='app';assert.equal(await surface(),'samantha_android');
  mode='voice';assert.equal(await surface(),'claw_live','a Samantha Voix hand-over never turns Wi-Fi off');
  mode='other';assert.equal(await surface(),'claw_live');
  mode='missing';assert.equal(await surface(),'claw_live');
  assert.equal(await tools.typedOwnerGraphSurface('bad id/../x'),'claw_live');

  // The brain's typed Orange call from this app turn now reaches the graph with the app surface.
  const views=path.join(root,'.openclaw/capability-views');fs.mkdirSync(views,{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json'),path.join(views,'agent-tools.json'));
  const helper=path.join(root,'helper.py');
  fs.writeFileSync(helper,"import sys,json\np=json.load(sys.stdin)\nprint(json.dumps({'state':'COMPLETED','received':p}))\n");
  const ctx={senderIsOwner:true,agentId:'main',sessionKey:'agent:main:companion-'+real.sessionId,sessionId:'s',
    assertInvocationCurrent(){}};
  const orange=tools.createTypedCapabilityTools(ctx,{home:root,helperPath:helper}).find(t=>t.name==='samantha_maxit_tunisie');
  const args={action:'telecom.orange.balances',params:{}};
  const call=async id=>{guard.agentCapabilityHook({toolName:orange.name,params:args,toolCallId:id},
    {requester:{senderIsOwner:true},agentId:'main',runId,sessionKey:ctx.sessionKey,sessionId:'s'});
    return JSON.parse((await orange.execute(id,args)).content[0].text).received.host;};
  mode='app';let host=await call('call-app');
  assert.equal(host.graphSurface,'samantha_android');assert.equal(host.surface,'app');assert.equal(host.userRunId,runId);
  mode='voice';host=await call('call-voice');assert.equal(host.graphSurface,'claw_live');
  await new Promise(resolve=>server.close(resolve));
  host=await call('call-down');assert.equal(host.graphSurface,'claw_live','an unreachable Companion keeps the restriction');

  // Companion side: a Samantha Voix hand-over is recorded as such and survives a registry reload.
  const voice=await runs.reserveSubmittedRun('mon solde orange','voice-session','voice-client-0001',{executionSource:'gateway',voiceDelegation:true});
  const written=await runs.reserveSubmittedRun('mon solde orange','app-session','app-client-0001',{executionSource:'gateway'});
  assert.equal((await runs.getRunStatus(voice.status.runId)).turnOrigin,'voice');
  assert.equal((await runs.getRunStatus(written.status.runId)).turnOrigin,'app');
  const stored=JSON.parse(fs.readFileSync(path.join(root,'clawmobile-companion/runs.json'),'utf8')).runs;
  assert.equal(stored.find(r=>r.runId===voice.status.runId).voiceDelegation,true);
  assert.equal(stored.find(r=>r.runId===written.status.runId).voiceDelegation,undefined);
  for(const key of Object.keys(require.cache))if(key.includes(`${path.sep}dist${path.sep}companion${path.sep}`))delete require.cache[key];
  const reloaded=require('../dist/companion/runs.js');
  assert.equal((await reloaded.getRunStatus(voice.status.runId)).turnOrigin,'voice');
  assert.equal((await reloaded.getRunStatus(written.status.runId)).turnOrigin,'app');
  console.log('typed-app-surface: PASS (written app turn → app surface, Samantha Voix and unproven runs keep the live-voice restriction)');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
