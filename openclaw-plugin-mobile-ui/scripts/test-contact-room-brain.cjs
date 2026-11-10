// Amine 02/11 — conversion step 4 of « Le cerveau partout »: every WhatsApp contact room (agenda, actions, messages,
// and their combinations with Pulse) gets the same brain as the Pulse room: one factory, one guard, one principal
// format `room:<pièce>:wa-…`. The native contactRoomFastPath interception is gone (no switch, no native fallback).
// Real S24 data: fixtures/s24-2026-11-02-contact-rooms-brain (room domains' tool projection, room agents' tool
// policies, grant combinations) and fixtures/s24-2026-11-02-pulse-room-brain (Pulse tool, the recette contact's grant).
// With ROOM_PLAYBOOKS_ROOT, the exact private payloads are replayed into playbooks room_tool_turn (owners mocked).
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
  {execFileSync}=require('node:child_process');
const ROOMS_FIX=path.join(__dirname,'../fixtures/s24-2026-11-02-contact-rooms-brain/room-tools.json');
const PULSE_FIX=path.join(__dirname,'../fixtures/s24-2026-11-02-pulse-room-brain');
const rooms=JSON.parse(fs.readFileSync(ROOMS_FIX,'utf8'));
const pulseTool=JSON.parse(fs.readFileSync(path.join(PULSE_FIX,'pulse-tool.json'),'utf8'));
const grantFixture=JSON.parse(fs.readFileSync(path.join(PULSE_FIX,'room-grant-recette.json'),'utf8'));
const catalogue=[...pulseTool.tools,...rooms.tools];
const home=fs.mkdtempSync(path.join(os.tmpdir(),'contact-rooms-'));
fs.mkdirSync(path.join(home,'.openclaw/capability-views'),{recursive:true});
fs.writeFileSync(path.join(home,'.openclaw/capability-views/agent-tools.json'),
  JSON.stringify({version:1,capabilityRevision:rooms.capabilityRevision,tools:catalogue}));
process.env.HOME=home;process.env.SAMANTHA_BRAIN_ONLY='1';
const guard=require('../dist/capabilityAgentGuard.js');
const brain=require('../dist/roomBrain.js');
const profile=require('../dist/contactRoomProfile.js');
const typed=require('../dist/typedCapabilityTools.js');

// The recette contact (fictitious +216 10 000 001), here granted agenda, actions and messages: its routed agent.
const contact=grantFixture.allowlist_get.contact;
const GRANTED=['conversation','agenda','actions','messages'];
const agent='contacts-agenda-actions-messages';
const sessionKey=`agent:${agent}:whatsapp:direct:${contact.e164}`;
const grantValue=(rooms=GRANTED)=>({success:true,state:'ok',receipt:null,...JSON.parse(JSON.stringify(contact)),rooms,historyCount:2});
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const ctxFor=(a=agent,key=sessionKey,extra={})=>({agentId:a,sessionKey:key,sessionId:'s-room',senderIsOwner:false,
  messageChannel:'whatsapp',assertInvocationCurrent(){if(this.revoked)throw Error('revoked');},...extra});
let runSeq=0;
function bind(name,args,callId,runId,extra={},a=agent,key=sessionKey){
  return guard.agentCapabilityHook({toolName:name,params:args,toolCallId:callId},
    {requester:{senderIsOwner:false},agentId:a,runId,sessionKey:key,sessionId:'s-room',...extra});
}
function harness({grant=()=>grantValue(),replies=[],a=agent,key=sessionKey,ctx}={}){
  const reads=[],payloads=[];const queue=[...replies];
  const tools=brain.createRoomTools(ctx||ctxFor(a,key),{home,
    readGrant:async id=>{reads.push(id);const v=grant(reads.length);if(v instanceof Error)throw v;return v;},
    runTyped:async input=>{const p=JSON.parse(input);payloads.push(p);const next=queue.shift();
      if(next instanceof Error)throw next;return typeof next==='function'?next(p):next;}});
  return {tools,tool:name=>tools.find(t=>t.name===name),reads,payloads};
}
async function call(h,name,args,runId=`run-${++runSeq}`,callId=`call-${runSeq}-${Math.random().toString(16).slice(2,8)}`,a=agent,key=sessionKey){
  assert.equal(bind(name,args,callId,runId,{},a,key).block,undefined);
  const out=await h.tool(name).execute(callId,args);
  return {out,body:JSON.parse(out.content[0].text),reply:out.details?.toolText,runId,callId};
}
const STATUS={action:'device.status.read',params:{}};
const TORCH={action:'device.torch.set',params:{on:true}};
const EVENT={action:'agenda.event.create',params:{title:'Point projet',start_time:'2026-11-05T10:00:00+01:00',end_time:'2026-11-05T11:00:00+01:00'}};
const SEND={action:'messaging.send',params:{recipient:'Sadok',message:'J’arrive dans 10 minutes.'}};

(async()=>{
  // ---- 0. The S24 inventory this lot is built on (02/11, read-only capture) --------------------------------------
  eq(Object.keys(rooms.room_agents).sort(),['contacts','contacts-projet','contacts-projet-pulse','contacts-pulse']);
  eq(rooms.r17_bindings_by_agent,{'contacts-projet':1,'contacts-projet-pulse':2});
  ok(rooms.grants_by_rooms.every(g=>!g.rooms.some(r=>['agenda','actions','messages','qa'].includes(r))),
    'no agenda, actions, messages or qa grant on the S24 today');
  eq(rooms.tools.map(t=>t.name),['samantha_agenda','samantha_device_assistance','samantha_whatsapp']);

  // ---- 1. One room model, one factory ---------------------------------------------------------------------------
  eq([...profile.ROOM_TOOLS],['samantha_pulse','samantha_agenda','samantha_device_assistance','samantha_whatsapp','samantha_omniflow']);
  eq(profile.TYPED_ROOMS,['pulse','agenda','actions','messages','omniflow']);
  eq(brain.UNTYPED_ROOMS,{qa:'room_domain_not_typed'});
  for(const [granted,routed] of [[['conversation','agenda'],'contacts-agenda'],[GRANTED,agent],
      [['conversation','projet','pulse','agenda'],'contacts-projet-pulse-agenda'],[['conversation','pulse'],'contacts-pulse'],
      [['conversation','projet','pulse'],'contacts-projet-pulse'],[['conversation','projet'],'contacts-projet'],
      [['conversation','qa'],'contacts-qa'],[['conversation','omniflow'],'contacts-omniflow'],[['maison'],null],[['conversation'],null],[['salon'],null]])
    eq(profile.roomAgentFor(granted),routed,granted.join(','));
  const h0=harness();
  eq(h0.tools.map(t=>t.name),['samantha_agenda','samantha_device_assistance','samantha_whatsapp']);
  ok(h0.tools.every(t=>!('canDeliverSourceReply' in t)&&t.catalogMode==='direct-only'));
  const enumOf=name=>h0.tool(name).parameters.properties.action.enum;
  eq(enumOf('samantha_agenda'),['agenda.event.create','agenda.event.read','agenda.event.update','agenda.reminder.schedule'],'no candidate (agenda.sync)');
  eq(enumOf('samantha_device_assistance').length,20);eq(enumOf('samantha_whatsapp'),['messaging.send']);
  ok(h0.tools.every(t=>!t.parameters.properties.action.enum.some(a=>['confirm','cancel'].includes(a))),'no owner confirmation operation');
  ok(/pièce Agenda/.test(h0.tool('samantha_agenda').description)&&!/Pulse/.test(h0.tool('samantha_agenda').description));
  const combined=`agent:contacts-pulse-agenda:whatsapp:direct:${contact.e164}`;
  eq(brain.createRoomTools(ctxFor('contacts-pulse-agenda',combined),{home}).map(t=>t.name),['samantha_pulse','samantha_agenda']);
  eq(brain.createRoomTools(ctxFor('contacts-agenda',`agent:contacts-agenda:whatsapp:direct:${contact.e164}`),{home}).map(t=>t.name),['samantha_agenda']);
  // No typed owner (qa), no typed room (projet, plain contacts), the owner, another agent, a group, another channel.
  for(const [a,key,extra] of [['contacts-qa',`agent:contacts-qa:whatsapp:direct:${contact.e164}`],
      ['contacts-projet',`agent:contacts-projet:whatsapp:direct:${contact.e164}`],['contacts',`agent:contacts:whatsapp:direct:${contact.e164}`],
      [agent,sessionKey,{senderIsOwner:true}],['contacts-agenda',sessionKey],[agent,`agent:${agent}:whatsapp:group:123@g.us`],
      [agent,sessionKey,{messageChannel:'telegram'}],['main','agent:main:whatsapp:direct:+21610000009',{senderIsOwner:true}],
      ['contacts-messages-agenda',`agent:contacts-messages-agenda:whatsapp:direct:${contact.e164}`]])
    eq(brain.createRoomTools(ctxFor(a,key,extra||{}),{home}),null,`${a} ${key}`);
  eq(typed.createTypedCapabilityTools(ctxFor(),{home}),null,'owner typed tools never reach a contact');
  // The Gateway registration: one factory for every room; no contact room interception before the brain.
  const registered=[],hooks={};require('../dist/index.js').register({on(name,fn){(hooks[name]||=[]).push(fn);},
    registerTool(def,opts){registered.push([def,opts]);},registerGatewayMethod(){},logger:{},session:{}});
  const factory=registered.find(([def])=>def&&def.contextVersion===2);ok(factory,'typed factory registered');
  ok([...profile.ROOM_TOOLS].every(name=>factory[1].names.includes(name)));
  eq(factory[0].create(ctxFor()).map(t=>t.name),['samantha_agenda','samantha_device_assistance','samantha_whatsapp']);
  eq(factory[0].create(ctxFor('contacts-qa',`agent:contacts-qa:whatsapp:direct:${contact.e164}`)),null);
  ok(factory[0].create({agentId:'main',sessionKey:'agent:main:companion-chat-x',senderIsOwner:true}).some(t=>t.name==='samantha_catalogue'));
  for(const handler of hooks.before_dispatch||[])
    eq(await handler({content:'mon agenda demain',sessionKey,channel:'whatsapp',messageId:'m-1'},{sessionKey,agentId:agent,channelId:'whatsapp'}),
      undefined,'a contact room message goes to its brain');
  eq(fs.existsSync(path.join(__dirname,'../dist/contactRoomFastPath.js')),false,'native interception removed from the build');
  const indexSource=fs.readFileSync(path.join(__dirname,'../src/index.ts'),'utf8');
  ok(!/contactRoomFastPath|handleContactRoomBeforeDispatch/.test(indexSource),'no contact room hook in index.ts');

  // ---- 2. Guard: one principal per room tool, never the owner, never another room ---------------------------------
  const read={action:'agenda.event.read',params:{calendar_id:'primary',time_min:'2026-11-03T00:00:00+01:00',time_max:'2026-11-04T00:00:00+01:00'}};
  eq(bind('samantha_agenda',read,'g-1','run-g').block,undefined);
  eq(bind('samantha_pulse',{action:'project.search',params:{}},'g-2','run-g').block,true,'a room the session does not hold');
  eq(bind('samantha_agenda',read,'g-3','run-g',{requester:{senderIsOwner:true}}).block,true,'never as the owner');
  eq(bind('samantha_agenda',read,'g-4','run-g',{agentId:'contacts-agenda'}).block,true,'agent and session agree');
  eq(bind('samantha_agenda',read,'g-5','run-g',{agentId:undefined}).block,undefined,'SDK without agentId: the session names it');
  eq(bind('samantha_maxit_tunisie',{action:'telecom.balance',params:{}},'g-6','run-g').block,true,'an owner tool');
  for(const key of [`agent:contacts:whatsapp:direct:${contact.e164}`,`agent:contacts-qa:whatsapp:direct:${contact.e164}`,
      `agent:contacts-projet:whatsapp:direct:${contact.e164}`])
    eq(bind('samantha_agenda',read,'g-7'+key.length,'run-g',{agentId:undefined},undefined,key).block,true,key);
  // The room proof names the tool's room; it is consumed once, by that room's tool only, never by the owner tools.
  assert.equal(bind('samantha_device_assistance',STATUS,'g-8','run-g').block,undefined);
  assert.throws(()=>guard.consumeRoomInvocation('g-8','samantha_agenda',STATUS,ctxFor()),/typed_host_admission_required/);checks++;
  assert.equal(bind('samantha_device_assistance',STATUS,'g-9','run-g').block,undefined);
  eq(guard.consumeRoomInvocation('g-9','samantha_device_assistance',STATUS,ctxFor()).principal,'room:actions:'+contact.contactId);
  assert.equal(bind('samantha_agenda',read,'g-10','run-g').block,undefined);
  assert.throws(()=>guard.consumeTypedInvocation('g-10','samantha_agenda',read,{senderIsOwner:true,sessionKey,assertInvocationCurrent(){}}),
    /typed_host_admission_required/);checks++;
  guard.agentCapabilityHook({toolName:'samantha_agenda',params:read,toolCallId:'owner-proof'},
    {requester:{senderIsOwner:true},agentId:'main',runId:'owner-run',sessionKey:'agent:main:whatsapp:direct:+21600000000'});
  let h=harness({replies:[{state:'COMPLETED',answer:'x'}]});
  let r=await h.tool('samantha_agenda').execute('owner-proof',read);
  eq([r.details.toolText,h.reads.length,h.payloads.length],[brain.roomToolReply({}, 'agenda').details.toolText,0,0],
    'an owner proof is never a room proof');

  // ---- 3. The room grant: read once per message, for every room tool of the run ---------------------------------
  const agendaAccess='L’accès à la pièce Agenda n’est pas confirmé. Rien n’a été exécuté.';
  const revoked=[{...grantValue(),success:false},{...grantValue(),state:'suspended'},{...grantValue(),owner:true},
    grantValue(['conversation','agenda','actions']),grantValue(['conversation','projet','agenda','actions','messages']),
    grantValue(['maison']),{...grantValue(),expiresAt:'2026-01-01T00:00:00Z'},{...grantValue(),e164:'+21610000002'},
    {...grantValue(),contactId:'wa-0000000000000000'},Object.assign(new Error('allowlist_unavailable'),{statusCode:503})];
  for(const value of revoked){
    h=harness({grant:()=>value});const res=await call(h,'samantha_agenda',read);
    eq([res.reply,res.body.reasonCode,h.payloads.length],[agendaAccess,'room_grant_revoked',0],JSON.stringify(value).slice(0,80));
  }
  h=harness({replies:[{state:'COMPLETED',answer:'Demain : rien de prévu.'},{state:'COMPLETED',answer:'Batterie : 80 %.'}]});
  await call(h,'samantha_agenda',read,'message-1');await call(h,'samantha_device_assistance',STATUS,'message-1');
  eq(h.reads.length,1,'two room tools in one message, one grant read');
  await call(h,'samantha_device_assistance',STATUS,'message-2');eq(h.reads.length,2,'a new message reads again');

  // ---- 4. The host payload names the contact and the room, never the owner --------------------------------------
  h=harness({replies:[{state:'COMPLETED',answer:'Demain : rien de prévu.'}]});
  r=await call(h,'samantha_agenda',read);
  const sent=h.payloads[0],conversationKey=`agenda-room:${agent}:${contact.contactId}:${sessionKey}`;
  eq(sent.host,{room:'agenda',contactId:contact.contactId,conversationKey,userRunId:r.runId,invocationId:r.callId,
    surface:'pulse_room',graphSurface:'whatsapp'});
  ok(!('owner' in sent.host)&&!JSON.stringify(sent).includes('"caller"'),'no owner flag nor caller from the host');
  eq(sent.command,{operation:'call',domain:'agenda',action:'agenda.event.read',params:read.params});
  eq([sent.roomAdmission.schema_version,sent.roomAdmission.conversation_key,sent.roomAdmission.event_ref],
    ['native-pulse.v1',conversationKey,`${r.runId}:${r.callId}`]);
  eq(r.reply,'Demain : rien de prévu.','the owner sentence is delivered as is');
  h=harness({replies:[{state:'COMPLETED',answer:'Le résultat de la demande reste à vérifier.',facts:{events:[]}}]});
  r=await call(h,'samantha_agenda',read);eq(r.reply,undefined);eq(r.body.facts,{events:[]});
  ok(/^Faits vérifiés renvoyés de l’agenda\. Réponds au contact uniquement avec ces faits/.test(r.body.instruction));

  // ---- 5. Inside the room: everything; outside and the owner's SMS and photos: refused before any read ------------
  const refusal='Ici je ne traite que l’agenda d’Amine, les réglages et actions courantes de son téléphone et l’envoi de messages WhatsApp en son nom. Pour le reste, vois directement avec Amine.';
  eq(brain.roomRefusal(['agenda','actions','messages']),refusal);eq(brain.roomRefusal(['pulse']),brain.PULSE_ROOM_REFUSAL);
  h=harness();
  for(const args of [{action:'agenda.sync',params:{}},{action:'project.search',params:{}}]){
    r=await call(h,'samantha_agenda',args);eq([r.reply,r.body.state,r.body.reasonCode],[refusal,'OUTSIDE_SCOPE','scope_outside']);
  }
  for(const action of ['device.sms.latest','device.photos.today']){
    r=await call(h,'samantha_device_assistance',{action,params:{}});
    eq([r.reply,r.body.state,r.body.reasonCode],[brain.OWNER_PRIVATE_REFUSAL,'DENIED','scope_owner_private']);
  }
  eq([h.reads.length,h.payloads.length],[0,0]);
  eq(brain.roomToolReply({state:'DENIED',reasonCode:'scope_owner_private'},'actions',refusal).details.toolText,brain.OWNER_PRIVATE_REFUSAL);
  eq(brain.roomToolReply({state:'OUTSIDE_SCOPE',reasonCode:'scope_outside'},'agenda',refusal).details.toolText,refusal);
  eq(brain.roomToolReply({state:'DENIED',reasonCode:'scope_forbidden'},'messages',refusal).details.toolText,refusal);
  // In a combined Pulse room the Pulse constraints stay: leave requests refused, outside named for both rooms.
  h=harness({a:'contacts-pulse-agenda',key:combined,grant:()=>grantValue(['conversation','pulse','agenda'])});
  r=await call(h,'samantha_pulse',{action:'leave.request',params:{start_at:'2026-11-10',end_at:'2026-11-12'}},undefined,undefined,'contacts-pulse-agenda',combined);
  eq([r.reply,r.body.reasonCode],[brain.LEAVE_REQUEST_REFUSAL,'scope_leave_request']);
  r=await call(h,'samantha_pulse',{action:'device.torch.set',params:{}},undefined,undefined,'contacts-pulse-agenda',combined);
  // Recette 03/11: the Pulse subjects are those of the room's actions (this capture: no finance.ca).
  eq(r.reply,'Ici je ne traite que Pulse (projets, offres, évaluations, CRA, congés de l\'équipe et solde de congés) et l’agenda d’Amine. Pour le reste, vois directement avec Amine.');

  // ---- 6. Writes: prepared, grant re-read, then handed off; stopped when the grant is gone; never replayed ---------
  h=harness({replies:[{state:'READY',prepared:{goalRef:'goal-1'}},{state:'COMPLETED',answer:'Torche allumée.'}]});
  r=await call(h,'samantha_device_assistance',TORCH);
  eq(h.payloads.map(p=>p.command.operation),['call','handoff']);
  eq(h.payloads[1].command,{operation:'handoff',domain:'device-assistance',goalRef:'goal-1'});
  eq(h.reads.length,2,'one message read, one more right before the write');eq(h.payloads[1].host,h.payloads[0].host);
  eq(r.reply,'Torche allumée.');
  h=harness({grant:n=>n===1?grantValue():{...grantValue(),state:'suspended'},
    replies:[{state:'READY',reasonCode:'pulse_room_direct_write',prepared:{goalRef:'goal-2'}},{state:'CANCELLED'}]});
  r=await call(h,'samantha_whatsapp',SEND);
  eq(h.payloads.map(p=>[p.command.operation,p.command.reason]),[['call',undefined],['abort','admission_revoked']]);
  eq(r.reply,'L’action était prête, mais l’accès à la pièce Messages n’est plus confirmé : rien n’a été envoyé sur WhatsApp.');
  {const ctx=ctxFor();const payloads=[];
   const t=brain.createRoomTools(ctx,{home,readGrant:async()=>grantValue(),runTyped:async i=>{const p=JSON.parse(i);payloads.push(p);
     if(p.command.operation==='call'){ctx.revoked=true;return {state:'READY',prepared:{goalRef:'goal-3'}};}return {state:'CANCELLED'};}})
     .find(x=>x.name==='samantha_agenda');
   assert.equal(bind(t.name,EVENT,'stop-1','run-stop').block,undefined);
   const res=await t.execute('stop-1',EVENT);
   eq(payloads.map(p=>[p.command.operation,p.command.reason]),[['call',undefined],['abort','admission_revoked']],'a user Stop aborts');
   ok(/pièce Agenda n’est plus confirmé/.test(res.details.toolText));}
  h=harness({replies:[{state:'READY',prepared:{goalRef:'goal-4'}},new Error('killed')]});
  r=await call(h,'samantha_device_assistance',TORCH);
  eq([r.reply,r.body.reasonCode,h.payloads.length],
    ['Je n’ai pas de résultat vérifié du téléphone pour cette demande. Rien n’est rejoué automatiquement : vérifie son état avant tout nouvel essai.','typed_outcome_unverified',2]);

  // ---- 7. Paired with the playbooks room owner (exact payloads, owners' processes mocked) -------------------------
  const peer=process.env.ROOM_PLAYBOOKS_ROOT;
  if(peer){
    h=harness({replies:[{state:'COMPLETED'},{state:'COMPLETED'},{state:'COMPLETED'},{state:'COMPLETED'}]});
    await call(h,'samantha_device_assistance',STATUS,'paired-1');await call(h,'samantha_device_assistance',TORCH,'paired-2');
    await call(h,'samantha_agenda',EVENT,'paired-3');await call(h,'samantha_whatsapp',SEND,'paired-4');
    const [readP,writeP,recapP,sendP]=h.payloads;
    const script=path.join(__dirname,'lib/contact-room-brain-paired.py');
    const out=JSON.parse(execFileSync('python3',[script,peer],{input:JSON.stringify({read:readP,write:writeP,recap:recapP,send:sendP}),
      encoding:'utf8',timeout:180000}));
    eq([out.read.state,out.read.dispatched.map(d=>d[2])],['COMPLETED',['status']]);
    eq([out.write.call.state,out.write.call.dispatched.length],['READY',0],'device write stopped at its hand-off');
    eq([out.write.next.state,out.write.next.dispatched.map(d=>d[2])],['COMPLETED',['torch-set']]);
    eq([out.write.again.replayed,out.write.again.dispatched.length],[true,0],'a replayed hand-off never acts twice');
    eq([out.recap.call.state,out.recap.call.reasonCode,out.recap.call.dispatched.length],['READY','pulse_room_direct_write',0]);
    eq([out.recap.next.state,out.recap.next.dispatched.map(d=>d[0])],['COMPLETED',['create_event.py']]);
    eq([out.send.call.state,out.send.call.reasonCode],['READY','pulse_room_direct_write']);
    ok(out.send.next.state!=='COMPLETED'&&out.send.again.state!=='COMPLETED'&&
      [out.send.call,out.send.next,out.send.again].every(x=>x.dispatched.length===0),'an aborted send never leaves');
    eq([out.owner_private.state,out.owner_private.reasonCode,out.owner_private.dispatched.length],['DENIED','scope_owner_private',0]);
    eq([out.foreign_domain.state,out.owner_principal_refused],['OUTSIDE_SCOPE',true]);
    console.log('paired with playbooks room owner at',peer);
  }
  console.log(`Contact rooms brain: ${checks} checks passed`);
  fs.rmSync(home,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=1;});
