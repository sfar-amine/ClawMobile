// Amine 02/11 — the Pulse room contact's brain: room tool only, contact principal, room grant re-read once per message
// and before a write, leave creation refused, answers from verified tool results only.
// Real S24 data: fixtures/s24-2026-11-02-pulse-room-brain (Pulse tool projection and the « Recette Pulse » room grant).
// With ROOM_PLAYBOOKS_ROOT, the exact private payload of the host is also replayed into the playbooks room owner
// (skill_intelligence.typed_tools.room_tool_turn), Pulse processes mocked: the host/owner contract is paired.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
  {execFileSync}=require('node:child_process');
const FIX=path.join(__dirname,'../fixtures/s24-2026-11-02-pulse-room-brain');
const toolFixture=JSON.parse(fs.readFileSync(path.join(FIX,'pulse-tool.json'),'utf8'));
const grantFixture=JSON.parse(fs.readFileSync(path.join(FIX,'room-grant-recette.json'),'utf8'));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'room-brain-'));
fs.mkdirSync(path.join(home,'.openclaw/capability-views'),{recursive:true});
fs.writeFileSync(path.join(home,'.openclaw/capability-views/agent-tools.json'),JSON.stringify(toolFixture));
process.env.HOME=home;process.env.SAMANTHA_BRAIN_ONLY='1';
const guard=require('../dist/capabilityAgentGuard.js');
const brain=require('../dist/pulseRoomBrain.js');
const typed=require('../dist/typedCapabilityTools.js');
const {ownerFoundationHook}=require('../dist/ownerBootstrapContext.js');

const contact=grantFixture.allowlist_get.contact;
const agent=grantFixture.routed_agent;
const sessionKey=`agent:${agent}:whatsapp:direct:${contact.e164}`;
const grantValue=()=>({success:true,state:'ok',receipt:null,...JSON.parse(JSON.stringify(contact)),historyCount:2});
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const roomCtx=(extra={})=>({agentId:agent,sessionKey,sessionId:'s-room',senderIsOwner:false,messageChannel:'whatsapp',
  assertInvocationCurrent(){if(this.revoked)throw Error('revoked');},...extra});
let runSeq=0;
function bind(name,args,callId,runId,extra={}){
  return guard.agentCapabilityHook({toolName:name,params:args,toolCallId:callId},
    {requester:{senderIsOwner:false},agentId:agent,runId,sessionKey,sessionId:'s-room',...extra});
}
function harness({grant=grantValue,replies=[]}={}){
  const reads=[],payloads=[];const queue=[...replies];
  const tools=brain.createPulseRoomTools(roomCtx(),{home,
    readGrant:async id=>{reads.push(id);const v=typeof grant==='function'?grant(reads.length):grant;if(v instanceof Error)throw v;return v;},
    runTyped:async input=>{const p=JSON.parse(input);payloads.push(p);const next=queue.shift();
      if(next instanceof Error)throw next;return typeof next==='function'?next(p):next;}});
  return {tool:tools[0],tools,reads,payloads};
}
async function call(h,args,runId=`run-${++runSeq}`,callId=`call-${runSeq}-${Math.random().toString(16).slice(2,8)}`){
  assert.equal(bind(h.tool.name,args,callId,runId).block,undefined);
  const out=await h.tool.execute(callId,args);
  return {out,body:JSON.parse(out.content[0].text),reply:out.details?.toolText,runId,callId};
}

(async()=>{
  // ---- 1. The room contact gets only its room tool (real S24 projection) -----------------------------------
  const h0=harness();
  eq(h0.tools.map(t=>t.name),['samantha_pulse']);
  ok(!('canDeliverSourceReply' in h0.tool)&&h0.tool.catalogMode==='direct-only','the model writes every reply (Amine 05/11), model-visible schema');
  const enumerated=h0.tool.parameters.properties.action.enum;
  ok(enumerated.includes('project.search')&&enumerated.includes('leave.balance')&&enumerated.includes('leave.request'));
  ok(!enumerated.includes('project.revenue')&&!enumerated.includes('project.set_status'),'no browser owner, no candidate');
  ok(!enumerated.includes('confirm')&&!enumerated.includes('cancel'),'no owner confirmation operation in the room');
  ok(JSON.stringify(h0.tool.parameters).indexOf('entity_id')<0,'host-only markers are not model-facing');
  // Owner typed tools never reach the contact; the room tool never reaches the owner, other agents or sessions.
  eq(typed.createTypedCapabilityTools(roomCtx(),{home}),null);
  eq(typed.createTypedCapabilityTools({...roomCtx(),senderIsOwner:true},{home}),null);
  eq(brain.createPulseRoomTools({agentId:'main',sessionKey:'agent:main:whatsapp:direct:+21610000009',senderIsOwner:true},{home}),null);
  eq(brain.createPulseRoomTools({...roomCtx(),senderIsOwner:true},{home}),null,'the owner never runs the contact brain');
  eq(brain.createPulseRoomTools({...roomCtx(),agentId:'contacts-projet'},{home}),null);
  eq(brain.createPulseRoomTools({...roomCtx(),agentId:'contacts-pulse'},{home}),null,'agent and session must agree');
  eq(brain.createPulseRoomTools({...roomCtx(),sessionKey:`agent:${agent}:whatsapp:group:123@g.us`},{home}),null);
  eq(brain.createPulseRoomTools({...roomCtx(),messageChannel:'telegram'},{home}),null);
  // The Gateway registration: one factory, the room tool for the room session, owner tools for main only.
  const registered=[];require('../dist/index.js').register({on(){},registerTool(def,opts){registered.push([def,opts]);},
    registerGatewayMethod(){},logger:{},session:{}});
  const factory=registered.find(([def])=>def&&def.contextVersion===2);ok(factory,'typed factory registered');
  ok(factory[1].names.includes('samantha_pulse'));
  eq(factory[0].create(roomCtx()).map(t=>t.name),['samantha_pulse']);
  eq(factory[0].create({agentId:'contacts',sessionKey:'agent:contacts:whatsapp:direct:+21610000002',senderIsOwner:false}),null);
  ok(factory[0].create({agentId:'main',sessionKey:'agent:main:companion-chat-x',senderIsOwner:true}).some(t=>t.name==='samantha_catalogue'));
  // No owner bootstrap, foundation or #126 skill preload in the contact session (even on an owner-skill word).
  const workspace=path.join(home,'.openclaw/workspace');fs.mkdirSync(path.join(workspace,'skills/samantha-agenda'),{recursive:true});
  fs.writeFileSync(path.join(workspace,'skills/samantha-agenda/SKILL.md'),'---\nname: samantha-agenda\n---\nAgenda\n');
  process.env.SAMANTHA_CONTEXT_FOUNDATION='1';
  for(const ws of [path.join(home,'.openclaw/workspace-projet'),workspace])
    eq(ownerFoundationHook({prompt:'Qu’est-ce que j’ai dans mon agenda demain ?'},{agentId:agent,sessionKey,workspaceDir:ws,trigger:'user'}),undefined);
  delete process.env.SAMANTHA_CONTEXT_FOUNDATION;
  ok(ownerFoundationHook({prompt:'Qu’est-ce que j’ai dans mon agenda demain ?'},{agentId:'main',sessionKey:'agent:main:whatsapp:direct:+1',workspaceDir:workspace,trigger:'user'})?.prependContext,
    'control: the owner main agent still gets its preload');

  // ---- 2. Typed admission: the room proof, the room grant, never the owner's ---------------------------------
  const read={action:'project.search',params:{project_query:'Projet Exemple'}};
  let h=harness({replies:[{state:'COMPLETED',answer:'Projet Exemple (20495) : en cours.'}]});
  let r=await h.tool.execute('no-proof',read);
  eq([r.details.toolText,h.reads.length,h.payloads.length],[brain.ROOM_UNVERIFIED,0,0],'no before_tool_call proof, nothing read or run');
  // An owner proof (main, senderIsOwner) is never consumed by the room tool, and a room proof never by the owner tools.
  guard.agentCapabilityHook({toolName:'samantha_pulse',params:read,toolCallId:'owner-proof'},
    {requester:{senderIsOwner:true},agentId:'main',runId:'owner-run',sessionKey:'agent:main:whatsapp:direct:+21600000000'});
  r=await h.tool.execute('owner-proof',read);eq(h.payloads.length,0);eq(r.details.toolText,brain.ROOM_UNVERIFIED);
  assert.equal(bind('samantha_pulse',read,'room-proof','run-x').block,undefined);
  assert.throws(()=>guard.consumeTypedInvocation('room-proof','samantha_pulse',read,{senderIsOwner:true,
    sessionKey,assertInvocationCurrent(){}}),/typed_host_admission_required/);checks++;
  // The contact's session cannot obtain another tool, nor as owner.
  eq(bind('samantha_agenda',{action:'agenda.read',params:{}},'agenda','run-y').block,true);
  eq(bind('samantha_pulse',read,'as-owner','run-z',{requester:{senderIsOwner:true}}).block,true);
  eq(bind('samantha_pulse',read,'other-agent','run-z',{agentId:'contacts-pulse'}).block,true);
  // The SDK may omit agentId in the hook context: the routed session key names the agent (never main's tools).
  eq(bind('samantha_pulse',read,'no-agent-id','run-z',{agentId:undefined}).block,undefined);
  eq(bind('samantha_agenda',{action:'agenda.read',params:{}},'no-agent-id-2','run-z',{agentId:undefined}).block,true);
  eq(guard.agentCapabilityHook({toolName:'samantha_pulse',params:read,toolCallId:'contact-plain'},
    {requester:{senderIsOwner:false},runId:'run-z',sessionKey:'agent:contacts:whatsapp:direct:+21610000002'}).block,true);
  // Without the room grant, or with a revoked one: refused before any typed helper.
  const revoked=[
    {...grantValue(),success:false},{...grantValue(),state:'suspended'},{...grantValue(),owner:true},
    {...grantValue(),rooms:['conversation','projet']},{...grantValue(),rooms:['conversation','pulse']},
    {...grantValue(),rooms:['conversation','projet','pulse','agenda']},{...grantValue(),rooms:['maison']},
    {...grantValue(),expiresAt:'2026-01-01T00:00:00Z'},{...grantValue(),e164:'+21610000002'},
    {...grantValue(),contactId:'wa-0000000000000000'},Object.assign(new Error('allowlist_unavailable'),{statusCode:503})];
  for(const value of revoked){
    h=harness({grant:value});const res=await call(h,read);
    eq([res.reply,res.body.reasonCode,h.payloads.length],[brain.ROOM_ACCESS_REFUSED,'room_grant_revoked',0],JSON.stringify(value).slice(0,80));
  }

  // ---- 3. The host payload names the contact, never the owner; the owner's scope is unreachable ----------------
  h=harness({replies:[{state:'COMPLETED',answer:'Projet Exemple (20495) : en cours.'}]});
  r=await call(h,read);
  const sent=h.payloads[0];
  eq(Object.keys(sent).sort(),['command','host','roomAdmission']);
  eq(sent.host,{room:'pulse',contactId:contact.contactId,conversationKey:`pulse-room:${agent}:${contact.contactId}:${sessionKey}`,
    userRunId:r.runId,invocationId:r.callId,surface:'pulse_room',graphSurface:'whatsapp'});
  ok(!('owner' in sent.host)&&!JSON.stringify(sent).includes('"caller"'),'no owner flag nor caller from the host');
  eq(sent.command,{operation:'call',domain:'pulse',action:'project.search',params:{project_query:'Projet Exemple'}});
  eq([sent.roomAdmission.schema_version,sent.roomAdmission.contact_id,sent.roomAdmission.event_ref,
    sent.roomAdmission.valid_until-sent.roomAdmission.observed_at],['native-pulse.v1',contact.contactId,`${r.runId}:${r.callId}`,30000]);

  // ---- 4. Leave: creating is refused (Amine's account), reading stays allowed ---------------------------------
  h=harness({replies:[{state:'COMPLETED',answer:'Solde de congé : 12 jours.'}]});
  r=await call(h,{action:'leave.request',params:{start_at:'2026-11-10',end_at:'2026-11-12'}});
  eq([r.reply,r.body.state,r.body.reasonCode,h.reads.length,h.payloads.length],
    [brain.LEAVE_REQUEST_REFUSAL,'DENIED','scope_leave_request',0,0]);
  ok(/compte Pulse d’Amine/.test(r.reply));
  r=await call(h,{action:'leave.balance',params:{}});
  eq([r.reply,h.payloads[0].command.action],['Solde de congé : 12 jours.','leave.balance']);
  // The playbooks owner's refusal of a leave request (scope_leave_request) renders the same sentence.
  eq(brain.roomToolReply({state:'DENIED',reasonCode:'scope_leave_request',answer:'x'}).details.toolText,brain.LEAVE_REQUEST_REFUSAL);

  // ---- 5. Outside the room's domain: refused, nothing read or run ---------------------------------------------
  // Recette 03/11: the subjects named are the room's actions (this capture has no finance.ca: no « chiffre d'affaires »).
  const roomRefusal=brain.roomRefusal(['pulse'],toolFixture.tools);
  ok(roomRefusal.startsWith('Ici je ne traite que Pulse : projets, offres, évaluations, CRA, ')&&!roomRefusal.includes('chiffre'));
  h=harness();r=await call(h,{action:'agenda.read',params:{}});
  eq([r.reply,r.body.state,h.reads.length,h.payloads.length],[roomRefusal,'OUTSIDE_SCOPE',0,0]);
  eq(brain.roomToolReply({state:'OUTSIDE_SCOPE',reasonCode:'scope_outside'}).details.toolText,brain.PULSE_ROOM_REFUSAL);
  eq(brain.roomToolReply({state:'DENIED',reasonCode:'scope_forbidden'}).details.toolText,brain.PULSE_ROOM_REFUSAL);

  // ---- 5b. The model writes every reply (Amine 05/11) ----------------------------------------------------------
  // S24 05/11 09:54: the partial creation of project 20933 reached Sadok as the bare generic failure, delivered past
  // the model. The result now goes to the model with its state, facts and cause; nothing is delivered as is.
  {const partial=brain.roomToolReply({state:'FAILED',reasonCode:'failed',
     answer:'La demande n’a pas abouti. Consulte le détail avant toute nouvelle action.',
     facts:{ok:false,state:'partial',project_id:'20933',steps:{project:true,phase:true,order:true,team:false,forecast:false},
       reason_code:'pulse_project_team_member_missing:Amine SFAR'}});
   const body=JSON.parse(partial.content[0].text);
   eq([body.state,body.facts.project_id,body.facts.steps.order,body.facts.steps.team],['FAILED','20933',true,false],'facts reach the model');
   ok(/Rédige toi-même la réponse au contact/.test(body.instruction),'the model writes the reply');
   ok(!('sourceReply' in partial.details),'no tool reply delivered past the model');
   const refused=brain.roomToolReply({state:'OUTSIDE_SCOPE',reasonCode:'scope_outside'});
   ok(!('sourceReply' in refused.details)&&/Rédige toi-même/.test(JSON.parse(refused.content[0].text).instruction),'refusals too');}

  // ---- 6. A Pulse read is answered from the tool result only ---------------------------------------------------
  h=harness({replies:[{state:'COMPLETED',answer:'Projet Exemple (20495) : en cours, 3 personnes.',facts:{ok:true}}]});
  r=await call(h,read);eq(r.reply,'Projet Exemple (20495) : en cours, 3 personnes.','the owner sentence is delivered as is, turn ended');
  // Only verified facts (opaque receipt sentence): the model gets the facts and the facts-only rule, no direct reply.
  h=harness({replies:[{state:'COMPLETED',answer:'Le résultat de la demande reste à vérifier.',facts:{ok:true,items:[{id:'20495'}]}}]});
  r=await call(h,read);eq(r.reply,undefined);eq(r.body.facts,{ok:true,items:[{id:'20495'}]});ok(/uniquement avec ces faits/.test(r.body.instruction));
  // Closed hours sentence of the Pulse manifest, a question for a missing value, a failure: delivered as is.
  const closed='Pulse est fermé en ce moment (ouvert du lundi au vendredi, 8 h - 18 h). Réessaie demain à 8 h.';
  eq(brain.roomToolReply({state:'TECHNICAL_FAILURE',reasonCode:'service_closed',answer:closed}).details.toolText,closed);
  eq(brain.roomToolReply({state:'NEEDS_INPUT',answer:'Pour créer le projet, il me manque : la date de fin. Peux-tu me la donner ?'})
    .details.toolText,'Pour créer le projet, il me manque : la date de fin. Peux-tu me la donner ?');
  eq(brain.roomToolReply({state:'TECHNICAL_FAILURE',reasonCode:'x',answer:''}).details.toolText,brain.ROOM_UNVERIFIED);
  h=harness({replies:[new Error('helper crashed')]});r=await call(h,read);eq([r.reply,r.body.reasonCode],[brain.ROOM_UNVERIFIED,'typed_turn_unavailable']);

  // ---- 7. A complete write: prepared, grant re-read, then direct-written; stopped when the grant is gone ----
  const write={action:'project.phase.set_status',params:{project_query:'20495',phase:'Build',state:'started'}};
  h=harness({replies:[{state:'READY',reasonCode:'pulse_room_direct_write',prepared:{goalRef:'goal-1'}},
    {state:'COMPLETED',answer:'La phase Build du projet 20495 est maintenant « Débuté » (vérifié dans Pulse).'}]});
  r=await call(h,write);
  eq(h.payloads.map(p=>p.command.operation),['call','handoff']);eq(h.payloads[1].command,{operation:'handoff',domain:'pulse',goalRef:'goal-1'});
  eq(h.reads.length,2,'one message read, one more right before the write');
  ok(h.payloads[1].roomAdmission.observed_at>=h.payloads[0].roomAdmission.observed_at);
  eq(h.payloads[1].host,h.payloads[0].host,'the hand-off is the same admitted event');
  eq(r.reply,'La phase Build du projet 20495 est maintenant « Débuté » (vérifié dans Pulse).');
  // Revoked between the preparation and the write: aborted, nothing sent to Pulse.
  h=harness({grant:n=>n===1?grantValue():{...grantValue(),state:'suspended'},
    replies:[{state:'READY',prepared:{goalRef:'goal-2'}},{state:'CANCELLED'}]});
  r=await call(h,write);
  eq(h.payloads.map(p=>[p.command.operation,p.command.reason]),[['call',undefined],['abort','admission_revoked']]);
  eq(r.reply,brain.ROOM_WRITE_STOPPED);
  // A user Stop of the run between the preparation and the write: aborted as well.
  {const ctx=roomCtx();const payloads=[];
   const t=brain.createPulseRoomTools(ctx,{home,readGrant:async()=>grantValue(),runTyped:async i=>{const p=JSON.parse(i);payloads.push(p);
     if(p.command.operation==='call'){ctx.revoked=true;return {state:'READY',prepared:{goalRef:'goal-3'}};}return {state:'CANCELLED'};}})[0];
   assert.equal(bind(t.name,write,'stop-1','run-stop').block,undefined);
   const res=await t.execute('stop-1',write);
   eq(payloads.map(p=>[p.command.operation,p.command.reason]),[['call',undefined],['abort','admission_revoked']]);
   eq(res.details.toolText,brain.ROOM_WRITE_STOPPED);}
  // The recette (deploy-parcours-room.cjs) builds the same private host identity.
  eq(brain.roomHost(require('../dist/contactRoomProfile.js').pulseRoomSession(agent,sessionKey),'r','c'),
    {room:'pulse',contactId:contact.contactId,conversationKey:`pulse-room:${agent}:${contact.contactId}:${sessionKey}`,
     userRunId:'r',invocationId:'c',surface:'pulse_room',graphSurface:'whatsapp'});
  // A hand-off with an unknown outcome is never replayed and says so.
  h=harness({replies:[{state:'READY',prepared:{goalRef:'goal-4'}},new Error('killed')]});
  r=await call(h,write);eq([r.reply,r.body.reasonCode,h.payloads.length],[brain.ROOM_UNVERIFIED,'typed_outcome_unverified',2]);

  // ---- 8. The grant is read once per incoming message, plus once before a write --------------------------------
  h=harness({replies:[{state:'COMPLETED',answer:'a'},{state:'COMPLETED',answer:'b'},{state:'COMPLETED',answer:'c'}]});
  await call(h,read,'message-1');await call(h,{action:'project.team',params:{project_query:'20495'}},'message-1');
  eq(h.reads.length,1,'two calls of one message, one read');
  await call(h,read,'message-2');eq(h.reads.length,2,'a new message reads again');
  h=harness({grant:n=>n===1?Object.assign(new Error('unavailable'),{statusCode:503}):grantValue(),
    replies:[{state:'COMPLETED',answer:'ok'}]});
  r=await call(h,read,'message-3');eq(r.reply,brain.ROOM_ACCESS_REFUSED);
  r=await call(h,read,'message-3');eq([r.reply,h.reads.length],['ok',2],'a failed read is never reused');

  // ---- 9. Paired with the playbooks room owner (exact payload, Pulse processes mocked) -------------------------
  const peer=process.env.ROOM_PLAYBOOKS_ROOT;
  if(peer){
    h=harness({replies:[{state:'COMPLETED',answer:'x'},{state:'COMPLETED',answer:'y'}]});
    const one=await call(h,{action:'leave.balance',params:{}},'paired-1');
    const two=await call(h,{action:'leave.request',params:{start_at:'2026-11-10',end_at:'2026-11-12'}},'paired-1');
    const three=await call(h,{action:'project.phase.set_status',params:{project_query:'20495',phase:'Build',state:'started'}},'paired-2');
    const script=path.join(__dirname,'lib/pulse-room-brain-paired.py');
    const out=JSON.parse(execFileSync('python3',[script,peer],{input:JSON.stringify(h.payloads),encoding:'utf8',timeout:120000}));
    eq(out.read.state,'COMPLETED');eq(out.read.dispatched,['pulse-leave.mjs','balance']);
    eq([out.write_prepared.state,out.write_prepared.reasonCode,!!out.write_prepared.prepared],['READY','pulse_room_direct_write',true]);
    eq(out.write_prepared.dispatched.at(-1),'--prepare-command','prepared, not written');
    eq([out.handoff.state,out.handoff.dispatched.at(-1)],['COMPLETED','--prepared-command-stdin']);
    eq(out.replayed_handoff_dispatches,0,'a replayed hand-off never writes twice');
    eq([out.owner_principal_refused,out.foreign_domain.state,out.leave_owner.state,out.leave_owner.reasonCode],
      [true,'OUTSIDE_SCOPE','DENIED','scope_leave_request']);
    eq(two.reply,brain.LEAVE_REQUEST_REFUSAL);ok(one&&three);
    console.log('paired with playbooks room owner at',peer);
  }
  console.log(`Pulse room brain: ${checks} checks passed`);
  fs.rmSync(home,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=1;});
