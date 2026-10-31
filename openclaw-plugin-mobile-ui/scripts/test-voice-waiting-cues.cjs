// Waiting cues of Samantha Voix (Amine 31/10/2026, « go pour tout »): one useful phrase per voice turn, from the typed tool
// the brain run started, then at most a soft earcon; one budget notice. Companion side: the run status carries the latest
// typed tool as progress.activity (name and action only) and the budget notice is « Je te donne la réponse dès que je l'ai. ».
// Real S24 captures: typed tool calls with their action (s24-2026-10-30-direct-call-id), the 30/10 brain run tool sequence
// (s24-2026-10-30-tool-search-direct), the typed tool names compiled on the S24 (s24-2026-10-25-typed-tools). The Gateway
// stream frame shape (stream "tool", data.name/phase/args/toolCallId) is the one the existing observer already reads.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-waiting-cues-'));
process.env.OPENCLAW_STATE_DIR=home;process.env.CLAWMOBILE_AGENT_ID='main';
const fixture=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures',name),'utf8'));
const direct=fixture('s24-2026-10-30-direct-call-id/direct-calls.json');
const sequence=fixture('s24-2026-10-30-tool-search-direct/brain-run-tool-sequence.json');
const compiled=fixture('s24-2026-10-25-typed-tools/compiled-agent-tools.json');
const contract=fixture('protocol/voice-v2-app-companion.json');
const client=require('../dist/companion/openclawAgentClient');
let gatewayCalls=0;
client.callOpenClawGateway=async()=>{gatewayCalls++;throw Error('unexpected owner read');};
const progress=require('../dist/companion/runProgress');
const brain=require('../dist/companion/voiceBrainDelegation');
const {TURN_BUDGET_MS}=require('../dist/companion/turnBudget');
let passed=0,serial=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
const expected=sid=>'agent:main:companion-chat-'+sid;
const frame=(id,sid,seq,data,stream='tool')=>({type:'event',event:'agent',payload:{runId:id,sessionKey:expected(sid),seq,stream,data}});
const terminal=(id,text)=>({runId:id,status:'ok',summary:'completed',result:{payloads:[{text}],meta:{stopReason:'stop'}}});
const settle=()=>new Promise(r=>setTimeout(r,20));

(async()=>{try{
 const runs=require('../dist/companion/runs');
 async function create(sid){const client='voice-cap-'+sid+'-'+(++serial);const r=await runs.reserveSubmittedRun('Quel est l\'état de mes factures',sid,client,{ownerAdmitted:true,userText:'Quel est l\'état de mes factures'});return {id:r.status.runId,client};}

 await test('a typed tool call of the S24 brain becomes an activity: its name and action, never its parameters',async()=>{
  for(const call of direct.calls){
   const a=progress.typedToolActivity(call.tool,{action:call.action,params:{calendar_id:'primary',time_min:'x'}},1793395302000);
   assert.deepEqual(a,{tool:call.tool,action:call.action,at:1793395302000});
  }
  // The 30/10 brain run read the bills through read/tool_search/exec: none of them is a typed Samantha activity.
  for(const call of sequence.calls)assert.equal(progress.typedToolActivity(call.tool,call.arguments),undefined,call.tool);
  // Every typed tool compiled on the S24 qualifies, discovery excepted.
  for(const tool of compiled.tools)assert.equal(progress.typedToolActivity(tool.name,{action:tool.actions[0].action})?.tool,tool.name);
  for(const name of sequence.typedToolNamesOnS24.names)assert.equal(progress.typedToolActivity(name,{})?.tool,name);
  assert.equal(progress.typedToolActivity('samantha_catalogue',{action:'search'}),undefined);
  for(const bad of ['tool_call','Samantha_agenda','samantha_','samantha_agenda;rm','openclaw:openclaw-plugin-mobile-ui:samantha_agenda',null,42])
   assert.equal(progress.typedToolActivity(bad,{}),undefined,String(bad));
  assert.deepEqual(progress.typedToolActivity('samantha_agenda',{action:'Agenda Read'}),{tool:'samantha_agenda'},'an unreadable action is dropped, the tool kept');
  assert.deepEqual(progress.typedToolActivity('samantha_agenda',['agenda.event.read']),{tool:'samantha_agenda'});
 });

 await test('transcript events (non observed read) give the same activity, latest typed call first',async()=>{
  const events=[
   {type:'tool.call',label:'Calling read.',detail:'{"path":"skills/samantha-factures/SKILL.md"}',at:1},
   {type:'tool.call',label:'Calling samantha_agenda.',detail:'{"action":"agenda.event.read","params":{"calendar_id":"primary"}}',at:2},
   {type:'tool.result',label:'Completed samantha_agenda.',at:3},
   {type:'tool.call',label:'Calling samantha_catalogue.',detail:'{"query":"factures"}',at:4},
   {type:'tool.call',label:'Calling exec.',at:5}];
  assert.deepEqual(progress.runActivity({events}),{tool:'samantha_agenda',action:'agenda.event.read',at:2});
  assert.equal(progress.runActivity({events:events.slice(0,1)}),undefined);
  assert.equal(progress.runActivity(undefined),undefined);
  // A recorded activity wins; a forged one is dropped field by field.
  assert.deepEqual(progress.runActivity({activity:{tool:'samantha_pulse',action:'pulse.read',at:9},events}),{tool:'samantha_pulse',action:'pulse.read',at:9});
  assert.deepEqual(progress.readRunActivity({tool:'samantha_utility_billing',action:'bill',params:{account:'secret'},text:'x'}),{tool:'samantha_utility_billing',action:'bill'});
  assert.equal(progress.readRunActivity({tool:'exec'}),undefined);
 });

 await test('the Gateway observer records the latest typed tool of the voice brain run, readable by id and by clientRunId, with no Gateway read',async()=>{
  const {id,client}=await create('waiting');const o=await runs.observeGatewayRun(id,expected('waiting'));o.sent();
  assert.equal((await runs.getRunStatus(id)).progress?.activity,undefined,'nothing before a typed call');
  o.event(frame(id,'waiting',1,{phase:'start',name:'read',toolCallId:'c0',args:{path:'skills/samantha-factures/SKILL.md'}}));
  o.event(frame(id,'other-session',2,{phase:'start',name:'samantha_pulse',toolCallId:'cx',args:{action:'pulse.read'}}));
  o.event(frame(id,'waiting',2,{phase:'start',name:'samantha_utility_billing',toolCallId:direct.calls[0].callId,args:{action:'bill.status',params:{provider:'steg'}}}));
  await settle();
  let byId=await runs.getRunStatus(id),byClient=await runs.getRunStatusByClientRunId(client);
  assert.equal(byId.progress.activity.tool,'samantha_utility_billing');assert.equal(byId.progress.activity.action,'bill.status');
  assert.deepEqual(byClient.progress.activity,byId.progress.activity,'the voice first reads the run by its clientRunId');
  assert.ok(!JSON.stringify(byId).includes('steg'),'parameters never reach the status');
  assert.ok(!byId.progress.steps?.some(s=>/samantha_/.test(s.label)),'an untitled typed call is never a public step');
  // Discovery and the result frame do not move the activity; a later typed call does.
  o.event(frame(id,'waiting',3,{phase:'result',name:'samantha_utility_billing',toolCallId:direct.calls[0].callId}));
  o.event(frame(id,'waiting',4,{phase:'start',name:'samantha_catalogue',toolCallId:'c2',args:{query:'agenda'}}));
  await settle();assert.equal((await runs.getRunStatus(id)).progress.activity.tool,'samantha_utility_billing');
  o.event(frame(id,'waiting',5,{phase:'start',name:direct.calls[1].tool,toolCallId:direct.calls[1].callId,args:{action:direct.calls[1].action,params:{title:'x',start_time:'2026-10-31T10:00'}}}));
  await settle();byId=await runs.getRunStatus(id);
  assert.deepEqual({tool:byId.progress.activity.tool,action:byId.progress.activity.action},{tool:'samantha_agenda',action:'agenda.event.create'});
  // A titled typed call is still a public step, as before.
  o.event(frame(id,'waiting',6,{phase:'start',name:'samantha_agenda',toolCallId:'c4',args:{action:'agenda.event.read',title:'Je consulte ton agenda'}}));
  await settle();assert.ok((await runs.getRunStatus(id)).progress.steps.some(s=>s.label==='Je consulte ton agenda'));
  await o.final(terminal(id,'Rendez-vous ajouté.'));
  const done=await runs.getRunStatus(id);assert.equal(done.state,'done');assert.equal(done.progress.activity.tool,'samantha_agenda');
  assert.equal(gatewayCalls,0,'status reads of an observed run stay local');
  // Registry reload: the stored activity is validated again, a forged field is dropped.
  const file=path.join(home,'clawmobile-companion/runs.json'),registry=JSON.parse(fs.readFileSync(file));
  const row=registry.runs.find(r=>r.runId===id);assert.ok(row.gatewayProgress.activity);
  row.gatewayProgress.activity={...row.gatewayProgress.activity,params:{secret:'never'},tool:'samantha_agenda'};
  fs.writeFileSync(file,JSON.stringify(registry));
  delete require.cache[require.resolve('../dist/companion/runs')];
  const reloaded=require('../dist/companion/runs');
  const again=await reloaded.getRunStatus(id);
  assert.equal(again.progress.activity.tool,'samantha_agenda');assert.ok(!JSON.stringify(again).includes('never'));
  const forged=JSON.parse(fs.readFileSync(file));forged.runs.find(r=>r.runId===id).gatewayProgress.activity={tool:'exec'};
  fs.writeFileSync(file,JSON.stringify(forged));
  delete require.cache[require.resolve('../dist/companion/runs')];
  assert.equal((await require('../dist/companion/runs').getRunStatus(id)).progress?.activity,undefined);
 });

 await test('the budget notice is one short sentence of information, the same in the shared contract',async()=>{
  assert.equal(brain.VOICE_PENDING_NOTICE,"Je te donne la réponse dès que je l'ai.");
  assert.equal(contract.deferredReadback.pendingNotice,brain.VOICE_PENDING_NOTICE);
  assert.ok(!/cherche encore/i.test(brain.VOICE_PENDING_NOTICE));
  const r=await brain.delegateVoiceTurnToBrain('Quel est l\'état de mes factures',
   {sessionId:'s-1',clientRunId:'voice-cap-voice-a',admission:{},assertCurrent:()=>{}},
   {submit:async()=>({success:true,accepted:true,submissionState:'accepted',runId:'run-1',state:'running'}),
    status:async()=>({success:true,runId:'run-1',state:'running',message:''}),budgetMs:5,pollMs:50,now:(()=>{let t=0;return()=>t+=10;})(),sleep:async()=>{}});
  assert.equal(r.state,'pending');assert.equal(r.text,brain.VOICE_PENDING_NOTICE);assert.equal(r.voice.verbatim,brain.VOICE_PENDING_NOTICE);
 });

 await test('the shared contract: one phrase per turn from a typed tool, cues inside the voice budget, three modes',async()=>{
  const w=contract.waitingCues;
  assert.deepEqual(w.modes,['phrase','sound','silence']);assert.equal(w.defaultMode,'phrase');assert.equal(w.phrasesPerTurn,1);
  assert.ok(w.firstCueMs+(w.maxCuesPerTurn-1)*w.repeatEveryMs<TURN_BUDGET_MS,'every cue lands before the budget notice');
  assert.deepEqual(w.excludedTools,['samantha_catalogue']);
  const tool=new RegExp(w.toolPattern),action=new RegExp(w.actionPattern);
  for(const name of Object.keys(w.phrases).filter(k=>k!=='default')){
   assert.match(name,tool);assert.ok(sequence.typedToolNamesOnS24.names.includes(name),name+' is a typed tool of the S24');
   assert.ok(progress.typedToolActivity(name,{}),name);
  }
  for(const call of direct.calls)assert.match(call.action,action);
  for(const text of Object.values(w.phrases)){assert.ok(text.length<=40&&/\.$/.test(text),text);assert.ok(!/encore|toujours/i.test(text),text);}
  assert.equal(w.phrases.samantha_utility_billing,'Je regarde tes factures.');assert.equal(w.phrases.default,"Je m'en occupe.");
 });

 console.log(`voice waiting cues: ${passed} cases PASS`);
}finally{fs.rmSync(home,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
