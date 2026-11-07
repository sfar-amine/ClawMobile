// Journey steps (Amine 07/11/2026): real S24 turns replayed as Gateway frames — typed tool steps in French with their
// measured durations, sanitized reasoning headers, total time, Cancel (official chat.abort) settled as Amine's stop.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'journey-steps-'));
process.env.OPENCLAW_STATE_DIR=home;process.env.CLAWMOBILE_AGENT_ID='main';
const fixture=require('../fixtures/s24-2026-11-07-journey-steps/turns.json');
const client=require('../dist/companion/openclawAgentClient');
let abort=null,calls=[];
client.callOpenClawGateway=async(method,params)=>{calls.push(method);if(method==='chat.abort'&&abort)return abort(params);throw Error('unexpected owner read '+method);};
const runs=require('../dist/companion/runs');
const progress=require('../dist/companion/runProgress');
const {interruptConversationGeneration}=require('../dist/companion/capabilityControl');
const realNow=Date.now;let clock=0;Date.now=()=>clock||realNow();
const key=sid=>client.expectedCompanionSessionKey(sid);
const tick=()=>new Promise(resolve=>setTimeout(resolve,300));
let serial=0;
async function create(sid){const r=await runs.reserveSubmittedRun('Public authored question',sid,'client-'+sid+'-'+(++serial),{ownerAdmitted:true,userText:'Public authored question'});return r.status.runId;}
const frame=(id,sid,seq,stream,data)=>({type:'event',event:'agent',payload:{runId:id,sessionKey:key(sid),seq,stream,data}});
const callsOf=turn=>turn.events.flatMap(e=>(e.content||[]).filter(b=>b.type==='toolCall').map(b=>({...b,at:e.at})));
const thoughtsOf=turn=>turn.events.flatMap(e=>(e.content||[]).filter(b=>b.type==='thinking').map(b=>({text:b.thinking,at:e.at})));
(async()=>{try{
 // Installed engine contract: tool start {phase,name,toolCallId,args}; thinking {text,delta}; delivered to session subscribers.
 assert.ok(fixture.engineContract.every(p=>p.found&&/^[a-f0-9]{64}$/.test(p.sha256)));
 assert.match(fixture.engineContract[0].excerpt,/phase: "start",\n\t+name: toolName,\n\t+toolCallId,/);
 assert.match(fixture.engineContract[1].excerpt,/stream: "thinking",\n\t+data: \{\n\t+text: trimmed,\n\t+delta/);
 assert.match(fixture.engineContract[2].excerpt,/evt\.stream === "thinking"/);

 // 1. French step of every real typed call; never a tool name. Internal tools stay invisible.
 const [orange,agenda]=fixture.turns;
 assert.deepEqual(callsOf(orange).map(c=>progress.publicToolLabel(c.name,{action:c.action})),['Je lis ton solde Orange']);
 assert.deepEqual(callsOf(agenda).map(c=>progress.publicToolLabel(c.name,{action:c.action})),
  ['Je consulte ton agenda','J’ajoute l’événement à ton agenda','J’annule l’action en attente']);
 const wrapped={id:'openclaw:openclaw-plugin-mobile-ui:samantha_agenda',args:{action:'agenda.event.read'}};
 assert.equal(progress.publicToolLabel('tool_call',wrapped),'Je consulte ton agenda');
 assert.deepEqual(progress.typedToolActivity('tool_call',wrapped,5),{tool:'samantha_agenda',action:'agenda.event.read',at:5});
 for(const internal of ['exec','read','tool_search','process','samantha_catalogue','sessions_history','progress_card'])
  assert.equal(progress.publicToolLabel(internal,{action:'list'}),undefined,internal);
 assert.equal(progress.publicToolLabel('tool_call',{id:'openclaw:core:exec',args:{}}),undefined);
 assert.equal(progress.publicToolLabel('samantha_steg',{action:'billing.unpaid'}),'Je regarde tes factures STEG');
 assert.equal(progress.publicToolLabel('web_search',{}),'Je cherche sur le web');

 // 2. Reasoning: real headers kept; body, identifiers, paths, links and long numbers never.
 assert.deepEqual(thoughtsOf(agenda).flatMap(t=>progress.reasoningThoughts(t.text)),
  ['Planning date retrieval for Nov 8','Clarifying default duration handling']);
 assert.deepEqual(progress.reasoningThoughts('**Checking the balance**\n\nI will call samantha_maxit_tunisie with the owner line.\n\n**Calling samantha_agenda now**\n\n**Reading ~/notes.md**\n\n**Number 98765432 found**\n\n**Using toolCall wrapper**\n\n**See https://x.y**'),
  ['Checking the balance']);
 assert.deepEqual(progress.readThoughts(['ok thought','bad_identifier',42,'x'.repeat(200)]),['ok thought']);

 // 3. Real Orange turn replayed on the observer: accepted 824130, call 827795, result 842359, answer 845791.
 clock=1794052824130;
 const sid='journey-orange',id=await create(sid),o=await runs.observeGatewayRun(id,key(sid));o.sent();await tick();
 let seq=0;const call=callsOf(orange)[0],[first,second]=thoughtsOf(orange);
 clock=first.at;o.event(frame(id,sid,++seq,'thinking',{text:first.text+'\n\nI need samantha_maxit_tunisie for the owner line.',delta:first.text}));
 clock=call.at;o.event(frame(id,sid,++seq,'tool',{phase:'start',name:call.name,toolCallId:call.id,args:{action:call.action}}));
 await tick();
 const live=await runs.getRunStatus(id);
 assert.equal(live.state,'running');assert.equal(live.progress.stoppable,true,'an admitted followed app run can be stopped');
 assert.deepEqual(live.progress.steps.map(s=>[s.label,s.state]),[['Demande reçue','done'],['Je lis ton solde Orange','running']]);
 assert.deepEqual(live.progress.reasoning,['Identifying need for call balances']);
 clock=orange.compressedToolResult.at;o.event(frame(id,sid,++seq,'tool',{phase:'result',name:call.name,toolCallId:call.id,isError:false}));
 clock=second.at;o.event(frame(id,sid,++seq,'thinking',{text:second.text,delta:second.text}));
 o.event(frame(id,sid,++seq,'assistant',{delta:'Ton solde…'}));
 await o.final({runId:id,status:'ok',result:{payloads:[{text:'Réponse vérifiée.'}],meta:{stopReason:'stop'}}});
 const done=await runs.getRunStatus(id);
 assert.equal(done.state,'done');assert.equal(done.progress.stoppable,undefined);
 assert.deepEqual(done.progress.steps.map(s=>[s.label,s.state,s.durationMs]),
  [['Demande reçue','done',undefined],['Je lis ton solde Orange','done',14564],['Réponse de Samantha','done',3432]]);
 assert.equal(done.progress.totalMs,21661);
 assert.deepEqual(done.progress.reasoning,['Identifying need for call balances','Verifying data completeness and observations']);
 // What the journey shows (steps, reasoning, live text): no tool name, action, call id or reasoning body.
 // (`activity` stays the voice's internal waiting cue and is never displayed.)
 const shown=JSON.stringify({steps:done.progress.steps,reasoning:done.progress.reasoning,text:done.progress.text});
 for(const hidden of ['samantha_','owner line','telecom.orange','call_d85c'])assert.ok(!shown.includes(hidden),hidden);
 // Persisted across a Companion restart (registry parser keeps steps' inputs and the sanitized reasoning only).
 const stored=JSON.parse(fs.readFileSync(path.join(home,'clawmobile-companion/runs.json'),'utf8')).runs.find(r=>r.runId===id);
 assert.deepEqual(stored.gatewayProgress.reasoning,done.progress.reasoning);

 // 4. Real agenda turn through the discovery wrapper: one step per call, the nested plugin call is the same step.
 clock=1794051246000;
 const sid2='journey-agenda',id2=await create(sid2),o2=await runs.observeGatewayRun(id2,key(sid2));o2.sent();await tick();
 const read=callsOf(agenda)[0];seq=0;
 clock=read.at;o2.event(frame(id2,sid2,++seq,'tool',{phase:'start',name:'tool_call',toolCallId:read.id,args:{id:'openclaw:openclaw-plugin-mobile-ui:samantha_agenda',args:{action:read.action}}}));
 o2.event(frame(id2,sid2,++seq,'tool',{phase:'start',name:'samantha_agenda',toolCallId:'nested-1',parentToolCallId:read.id,args:{action:read.action}}));
 o2.event(frame(id2,sid2,++seq,'tool',{phase:'start',name:'exec',toolCallId:'internal-1',args:{command:'never shown'}}));
 clock=agenda.events.find(e=>e.kind==='toolResult'&&e.callId===read.id).at;
 o2.event(frame(id2,sid2,++seq,'tool',{phase:'result',name:'samantha_agenda',toolCallId:'nested-1'}));
 o2.event(frame(id2,sid2,++seq,'tool',{phase:'result',name:'tool_call',toolCallId:read.id}));
 clock=agenda.events.find(e=>e.seq===9).at;
 await o2.final({runId:id2,status:'ok',result:{payloads:[{text:'Agenda lu.'}],meta:{stopReason:'stop'}}});
 const agendaDone=await runs.getRunStatus(id2);
 assert.deepEqual(agendaDone.progress.steps.map(s=>[s.label,s.durationMs]),[['Demande reçue',undefined],['Je consulte ton agenda',4789],['Réponse de Samantha',1602]]);
 assert.ok(!JSON.stringify(agendaDone.progress).includes('never shown'));

 // 5. Cancel: marker before the official abort; the aborted terminal racing the abort answer settles as Amine's stop.
 clock=0;
 const sid3='journey-stop',id3=await create(sid3),o3=await runs.observeGatewayRun(id3,key(sid3));o3.sent();await tick();
 o3.event(frame(id3,sid3,1,'tool',{phase:'start',name:'samantha_pulse',toolCallId:'pulse-1',args:{action:'finance.ca'}}));await tick();
 abort=async params=>{assert.equal(params.runId,id3);assert.equal(params.sessionKey,key(sid3));
  await o3.final({runId:id3,status:'ok',result:{payloads:[],meta:{aborted:true}}});return {ok:true,aborted:true,runIds:[id3]};};
 const stop=await interruptConversationGeneration(sid3,{operationId:'journey-stop-1',runId:id3},()=>{});
 assert.equal(stop.artifact.generationState,'abort_acknowledged');assert.equal(stop.artifact.effects,'not_undone');
 const stopped=await runs.getRunStatus(id3);
 assert.equal(stopped.state,'failed');assert.equal(stopped.progress.stopped,true);assert.equal(stopped.progress.stoppable,undefined);
 assert.equal(stopped.message,runs.OWNER_STOP_TEXT);assert.equal(stopped.progress.failedStep,undefined,'a stop is not a failed step');
 assert.deepEqual(stopped.progress.steps.map(s=>[s.label,s.state]),[['Demande reçue','done'],['Je lis le chiffre d’affaires dans Pulse','skipped'],['Arrêtée à ta demande','skipped']]);
 assert.equal(JSON.parse(fs.readFileSync(path.join(home,'clawmobile-companion/runs.json'),'utf8')).runs.find(r=>r.runId===id3).ownerStop.state,'acknowledged');

 // 6. Nothing aborted: the marker is cleared and the run still ends with its verified answer.
 const sid4='journey-not-running',id4=await create(sid4),o4=await runs.observeGatewayRun(id4,key(sid4));o4.sent();await tick();
 abort=async()=>({ok:true,aborted:false,runIds:[]});
 const none=await interruptConversationGeneration(sid4,{operationId:'journey-stop-2',runId:id4},()=>{});
 assert.equal(none.artifact.generationState,'not_running');
 assert.equal(JSON.parse(fs.readFileSync(path.join(home,'clawmobile-companion/runs.json'),'utf8')).runs.find(r=>r.runId===id4).ownerStop,undefined);
 await o4.final({runId:id4,status:'ok',result:{payloads:[{text:'Réponse normale.'}],meta:{stopReason:'stop'}}});
 const normal=await runs.getRunStatus(id4);assert.equal(normal.state,'done');assert.equal(normal.progress.stopped,undefined);

 // 7. Transport lost after a stop request: still Amine's stop, never « result to verify » nor a history read.
 const sid5='journey-lost',id5=await create(sid5),o5=await runs.observeGatewayRun(id5,key(sid5));o5.sent();await tick();
 assert.equal(await runs.recordOwnerStop(id5,key(sid5),'requested'),true);
 assert.equal(await runs.recordOwnerStop(id5,key('other'),'requested'),false,'another session cannot mark this run');
 await o5.lost(true);
 const lost=await runs.getRunStatus(id5);assert.equal(lost.state,'failed');assert.equal(lost.progress.stopped,true);
 // 6. Real typed result of 16:07 (isError false, state FAILED): the step is not shown as done.
 const failedFixture=require('../fixtures/s24-2026-11-07-journey-steps/typed-failed-result.json');
 assert.match(failedFixture.engineContract.excerpt,/result: eventResult/);
 const failedResult={content:failedFixture.toolResult.content};
 assert.equal(failedFixture.toolResult.isError,false);
 assert.equal(progress.typedToolReportedFailure(failedResult),true);
 for(const [state,failed] of [['COMPLETED',false],['NEEDS_CONFIRMATION',false],['TECHNICAL_FAILURE',true],['DENIED',true]])
  assert.equal(progress.typedToolReportedFailure({content:[{type:'text',text:JSON.stringify({state})}]}),failed,state);
 for(const odd of [undefined,null,{content:'x'},{content:[{type:'text',text:'pas du json'}]},{content:[{type:'image'}]}])
  assert.equal(progress.typedToolReportedFailure(odd),false);
 clock=1794064014193;
 const sid6='journey-failed',id6=await create(sid6),o6=await runs.observeGatewayRun(id6,key(sid6));o6.sent();await tick();
 const failedCall=failedFixture.toolResult.toolCallId;
 clock=1794064025473;o6.event(frame(id6,sid6,1,'tool',{phase:'start',name:'samantha_maxit_tunisie',toolCallId:failedCall,args:{action:'telecom.orange.balances'}}));
 clock=1794064026276;o6.event(frame(id6,sid6,2,'tool',{phase:'result',name:'samantha_maxit_tunisie',toolCallId:failedCall,isError:false,result:failedResult}));
 await o6.final({runId:id6,status:'ok',result:{payloads:[{text:'Je n’ai pas pu consulter tes soldes Orange.'}],meta:{stopReason:'stop'}}});
 const failedRun=await runs.getRunStatus(id6);
 assert.deepEqual(failedRun.progress.steps.map(s=>[s.label,s.state,s.durationMs]).slice(0,2),
  [['Demande reçue','done',undefined],['Je lis ton solde Orange','skipped',803]]);
 assert.equal(failedRun.progress.events.find(e=>e.callId===failedCall&&e.type!=='tool.call').type,'tool.error');
 assert.deepEqual(calls.filter(m=>m!=='chat.abort'),[],'no Gateway read for any journey fact');
 console.log('run journey steps: ok');
}catch(error){console.error(error);process.exitCode=1;}finally{Date.now=realNow;fs.rmSync(home,{recursive:true,force:true});}})();
