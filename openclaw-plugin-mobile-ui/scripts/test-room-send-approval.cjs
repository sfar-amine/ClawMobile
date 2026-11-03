// Amine 02/11 — a WhatsApp send in Amine's name from the messages room runs only after AMINE confirms that very send.
// Reused owners: the Companion owner confirmation (biometric, signed, single use), the app's confirmation screen opened
// from a Termux notification, the playbooks room owner's prepared command (handoff once, or abort).
// Covered: no send without Amine's confirmation; his confirmation sends exactly once; refusal or expiry sends nothing;
// the contact can never confirm on Amine's behalf. Real owner key pair (ECDSA P-256), real confirmation core,
// real S24 tool projection and grant fixtures; with ROOM_PLAYBOOKS_ROOT the real playbooks room owner (owners mocked).
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
  crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'room-send-'));
process.env.HOME=home;process.env.OPENCLAW_STATE_DIR=path.join(home,'.openclaw');
const rooms=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-11-02-contact-rooms-brain/room-tools.json'),'utf8'));
const grantFixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-11-02-pulse-room-brain/room-grant-recette.json'),'utf8'));
fs.mkdirSync(path.join(home,'.openclaw/capability-views'),{recursive:true});
fs.writeFileSync(path.join(home,'.openclaw/capability-views/agent-tools.json'),
  JSON.stringify({version:1,capabilityRevision:rooms.capabilityRevision,tools:rooms.tools}));
const guard=require('../dist/capabilityAgentGuard.js');
const brain=require('../dist/roomBrain.js');
const {createConfirmationCore}=require('../dist/companion/confirmationCore.js');
const {ownerKey}=require('../dist/companion/ownerConfirmationProtocol.js');
const approvals=require('../dist/companion/roomSendApprovals.js');
const note=require('../dist/backends/ownerConfirmationNotification.js');

let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const contact=grantFixture.allowlist_get.contact;
const agent='contacts-messages',sessionKey=`agent:${agent}:whatsapp:direct:${contact.e164}`;
const grantValue=(extra={})=>({success:true,state:'ok',receipt:null,...JSON.parse(JSON.stringify(contact)),
  rooms:['conversation','messages'],name:'Recette Pulse',...extra});
const SEND={action:'messaging.send',params:{recipient:'Sadok',message:'J’arrive dans 10 minutes, commence sans moi.'}};
const owner=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const intruder=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function core(clock){
  const rows=[];
  return {rows,core:createConfirmationCore({store:{read:async()=>rows,change:async op=>op(rows)},
    key:()=>ownerKey(owner.publicKey.export({type:'spki',format:'pem'})),clock})};
}
async function sign(c,id,key=owner.privateKey){
  const ch=await c.challenge(id);
  return c.confirm(id,{keyId:ch.keyId,nonce:ch.nonce,bindingHash:ch.bindingHash,
    signature:crypto.sign('sha256',Buffer.from(ch.challenge),key).toString('base64')});
}

(async()=>{
  // ---- 1. The room host: the send stops at its hand-off, Amine is asked, the contact is told it waits ----------------
  const ctx=(extra={})=>({agentId:agent,sessionKey,sessionId:'s',senderIsOwner:false,messageChannel:'whatsapp',
    agentAccountId:'default',assertInvocationCurrent(){},...extra});
  function host({replies,approval}){
    const payloads=[],asked=[];
    const tool=brain.createRoomTools(ctx(),{home,readGrant:async()=>grantValue(),
      runTyped:async input=>{const p=JSON.parse(input);payloads.push(p);return replies.shift();},
      requestOwnerApproval:async body=>{asked.push(body);if(approval instanceof Error)throw approval;return approval;}})
      .find(t=>t.name==='samantha_whatsapp');
    return {tool,payloads,asked};
  }
  let n=0;
  async function call(h,args){
    const id=`call-${++n}`,run=`run-${n}`;
    assert.equal(guard.agentCapabilityHook({toolName:'samantha_whatsapp',params:args,toolCallId:id},
      {requester:{senderIsOwner:false},agentId:agent,runId:run,sessionKey,sessionId:'s'}).block,undefined);
    const out=await h.tool.execute(id,args);return {reply:out.details?.sourceReply?.text,body:JSON.parse(out.content[0].text),run,id};
  }
  const pending=approvals.ROOM_SEND_TEXTS.pending('Sadok');
  let h=host({replies:[{state:'READY',reasonCode:'pulse_room_direct_write',prepared:{goalRef:'goal-0123456789abcdef0123',parameters:SEND.params}}],
    approval:{state:'awaiting_owner',confirmationRequestId:'x',reply:pending}});
  let r=await call(h,SEND);
  eq([r.reply,r.body.state,r.body.reasonCode],[pending,'PENDING_OWNER','owner_confirmation_required']);
  ok(/en attente de la confirmation d’Amine/.test(r.reply),'named state for the contact');
  eq(h.payloads.map(p=>p.command.operation),['call'],'the room host never hands the send off');
  eq(h.asked,[{schemaVersion:1,goalRef:'goal-0123456789abcdef0123',agentId:agent,sessionKey,userRunId:r.run,invocationId:r.id,
    accountId:'default',parameters:SEND.params}]);
  // The bound command differs from the model's arguments, or the Companion cannot ask: closed, nothing sent.
  for(const [prepared,approval,text] of [
    [{goalRef:'goal-1111111111111111aaaa',parameters:{recipient:'Autre',message:SEND.params.message}},{state:'awaiting_owner',reply:pending},approvals.ROOM_SEND_TEXTS.unavailable],
    [{goalRef:'goal-2222222222222222aaaa',parameters:SEND.params},new Error('owner_confirmation_not_presentable'),approvals.ROOM_SEND_TEXTS.notPresentable],
    [{goalRef:'goal-3333333333333333aaaa',parameters:SEND.params},new Error('owner_confirmation_unavailable'),approvals.ROOM_SEND_TEXTS.unavailable]]){
    h=host({replies:[{state:'READY',prepared},{state:'CANCELLED'}],approval});r=await call(h,SEND);
    eq([r.reply,r.body.state,h.payloads.map(p=>[p.command.operation,p.command.reason])],
      [text,'DENIED',[['call',undefined],['abort','owner_confirmation_unavailable']]]);
  }
  // The contact can never confirm: no confirm action in the room tool, no owner tool, no owner proof.
  h=host({replies:[],approval:null});
  for(const args of [{action:'confirm',params:{}},{action:'cancel',params:{}}]){
    r=await call(h,args);eq([r.body.state,h.payloads.length,h.asked.length],['OUTSIDE_SCOPE',0,0]);
  }
  ok(!h.tool.parameters.properties.action.enum.includes('confirm'));
  eq(guard.agentCapabilityHook({toolName:'samantha_whatsapp',params:SEND,toolCallId:'as-owner'},
    {requester:{senderIsOwner:true},agentId:agent,runId:'r',sessionKey}).block,true,'never as the owner');

  // ---- 2. The Companion consumer: Amine's confirmation, then exactly one hand-off ---------------------------------
  const notification=note.ownerConfirmationNotificationArgs('6f1c2a3b-4d5e-5f60-8a1b-2c3d4e5f6a7b','Samantha · Message à confirmer','x → y');
  ok(notification.includes('--action')&&notification[notification.indexOf('--action')+1].includes('ownerConfirmationNotification.js'));
  eq(note.ownerConfirmationOpenArgs('6f1c2a3b-4d5e-5f60-8a1b-2c3d4e5f6a7b'),['start','-n',
    'ai.samantha.android.dev/ai.samantha.android.OwnerConfirmationActivity','--es','confirmation_request_id','6f1c2a3b-4d5e-5f60-8a1b-2c3d4e5f6a7b']);
  assert.throws(()=>note.ownerConfirmationOpenArgs('x; rm -rf /'));checks++;
  function companion({grant=()=>grantValue(),handoff}={}){
    let now=Date.parse('2026-11-02T20:00:00Z');const timers=[];const typed=[],told=[],notified=[];
    const {core:c,rows}=core(()=>now);
    const a=approvals.createRoomSendApprovals({confirmations:c,clock:()=>now,timer:(fn,ms)=>{timers.push({fn,at:now+ms});return {};},
      readGrant:async()=>grant(),runTyped:async input=>{const p=JSON.parse(input);typed.push(p);
        if(p.command.operation==='handoff'&&handoff instanceof Error)throw handoff;
        return p.command.operation==='handoff'?(handoff||{state:'COMPLETED',answer:'Le résultat de la demande reste à vérifier.'}):{state:'CANCELLED'};},
      sendContact:async params=>{told.push(params);return {messageId:'m'};},
      notifyOwner:async(id,title,content)=>{notified.push({id,title,content});return true;}});
    return {a,c,rows,typed,told,notified,advance:ms=>{now+=ms;},fire:async()=>{for(const t of timers.splice(0))if(t.at<=now)await t.fn();},
      now:()=>now};
  }
  const body=(extra={})=>({schemaVersion:1,goalRef:'goal-0123456789abcdef0123',agentId:agent,sessionKey,userRunId:'run-1',
    invocationId:'call-1',accountId:'default',parameters:SEND.params,...extra});
  let k=companion();
  let asked=await k.a.request(body());
  eq([asked.state,asked.reply,k.typed.length,k.told.length],['awaiting_owner',pending,0,0],'nothing runs before Amine');
  const record=k.rows[0];
  eq(record.intent.presentation,{title:'Message au nom d’Amine',subtitle:'Recette Pulse → Sadok',
    description:'« J’arrive dans 10 minutes, commence sans moi. »'},'who asks, the recipient and the exact text');
  eq([record.intent.action.type,record.intent.action.reference,record.intent.origin],
    ['whatsapp.room_send','goal-0123456789abcdef0123',{channel:'samantha',id:'room:messages:'+contact.contactId}]);
  eq(k.notified,[{id:asked.confirmationRequestId,title:'Samantha · Message à confirmer',content:'Recette Pulse → Sadok'}]);
  eq((await k.a.request(body())).confirmationRequestId,asked.confirmationRequestId,'same goal, same request');
  eq([k.rows.length,k.a.pendingCount()],[1,1]);
  // No send without Amine's confirmation: a spurious decision, and a contact's forged proof, run nothing.
  eq((await k.a.decided(asked.confirmationRequestId)).state,'awaiting_owner');
  await assert.rejects(sign(k.c,asked.confirmationRequestId,intruder.privateKey),/invalid_owner_proof/);checks++;
  await k.a.decided(asked.confirmationRequestId);
  eq([k.typed.length,k.told.length,k.rows[0].state],[0,0,'awaiting_owner'],'a forged confirmation sends nothing');
  // Amine confirms: grant re-read, confirmation consumed, the same prepared command handed off exactly once.
  await sign(k.c,asked.confirmationRequestId);
  eq((await k.a.decided(asked.confirmationRequestId)).state,'sent');
  eq(k.typed.map(p=>p.command),[{domain:'whatsapp',goalRef:'goal-0123456789abcdef0123',operation:'handoff',
    ownerConfirmation:{requestId:asked.confirmationRequestId,bindingHash:k.rows[0].bindingHash}}]);
  eq(k.typed[0].host,{room:'messages',contactId:contact.contactId,conversationKey:`messages-room:${agent}:${contact.contactId}:${sessionKey}`,
    userRunId:'run-1',invocationId:'call-1',surface:'pulse_room',graphSurface:'whatsapp'});
  eq([k.rows[0].state,k.told.length,k.told[0].message,k.told[0].to,k.told[0].accountId],
    ['consumed',1,approvals.ROOM_SEND_TEXTS.confirmed('Sadok'),contact.e164,'default']);
  eq((await k.a.decided(asked.confirmationRequestId)).state,'not_pending');
  await assert.rejects(sign(k.c,asked.confirmationRequestId),/confirmation_already_decided|confirmation_not_pending/);checks++;
  eq([k.typed.length,k.told.length],[1,1],'sent exactly once, never replayed');
  // An owner sentence of the send owner is relayed as is.
  k=companion({handoff:{state:'COMPLETED',answer:'Message envoyé à Sadok.'}});asked=await k.a.request(body());
  await sign(k.c,asked.confirmationRequestId);await k.a.decided(asked.confirmationRequestId);eq(k.told[0].message,'Message envoyé à Sadok.');
  // Amine refuses: aborted, nothing sent, the contact is told.
  k=companion();asked=await k.a.request(body());await k.c.cancel(asked.confirmationRequestId);
  eq((await k.a.decided(asked.confirmationRequestId)).reason,'owner_refused');
  eq([k.typed.map(p=>[p.command.operation,p.command.reason]),k.told.map(t=>t.message)],
    [[['abort','owner_refused']],[approvals.ROOM_SEND_TEXTS.refused('Sadok')]]);
  // Expiry: aborted at the deadline, a late confirmation runs nothing.
  k=companion();asked=await k.a.request(body());k.advance(121000);await k.fire();
  eq([k.typed.map(p=>[p.command.operation,p.command.reason]),k.told.map(t=>t.message),k.a.pendingCount()],
    [[['abort','owner_confirmation_expired']],[approvals.ROOM_SEND_TEXTS.expired('Sadok')],0]);
  await assert.rejects(sign(k.c,asked.confirmationRequestId),/confirmation_not_pending|confirmation_already_decided/);checks++;
  eq((await k.a.decided(asked.confirmationRequestId)).state,'not_pending');eq(k.typed.length,1);
  // The grant is gone when Amine confirms: aborted before consuming, nothing sent.
  let revoked=false;k=companion({grant:()=>revoked?grantValue({state:'suspended'}):grantValue()});asked=await k.a.request(body());
  await sign(k.c,asked.confirmationRequestId);revoked=true;
  eq((await k.a.decided(asked.confirmationRequestId)).reason,'room_grant_revoked');
  eq([k.typed.map(p=>[p.command.operation,p.command.reason]),k.rows[0].state,k.told[0].message],
    [[['abort','admission_revoked']],'approved',approvals.ROOM_SEND_TEXTS.stopped]);
  // The hand-off's outcome is unknown: never retried.
  k=companion({handoff:new Error('killed')});asked=await k.a.request(body());await sign(k.c,asked.confirmationRequestId);
  eq((await k.a.decided(asked.confirmationRequestId)).state,'unverified');
  eq([k.typed.length,k.told[0].message],[1,approvals.ROOM_SEND_TEXTS.unknown]);
  // Refused before any confirmation is prepared: not the messages room, revoked grant, text Amine cannot read as is.
  k=companion({grant:()=>grantValue({rooms:['conversation','agenda']})});
  await assert.rejects(k.a.request(body()),/room_grant_revoked/);checks++;
  k=companion();
  for(const [change,error] of [[{parameters:{recipient:'Sadok',message:'ligne 1\nligne 2'}},/not_presentable/],
      [{parameters:{recipient:'Sadok',message:'x'.repeat(301)}},/not_presentable/],
      [{parameters:{recipient:'Sadok',message:' espace'}},/not_presentable/],
      [{agentId:'contacts-agenda',sessionKey:`agent:contacts-agenda:whatsapp:direct:${contact.e164}`},/invalid_room_send_request/],
      [{goalRef:'x'},/invalid_room_send_request/],[{extra:1},/invalid_room_send_request/],
      [{parameters:{recipient:'Sadok',message:'ok',extra:'x'}},/invalid_room_send_request/]])
    {await assert.rejects(k.a.request(body(change)),error);checks++;}
  eq([k.rows.length,k.typed.length,k.notified.length],[0,0,0]);
  // The route exists only behind the loopback owner flow, and its refusal is in the deploy acceptance.
  const server=fs.readFileSync(path.join(__dirname,'../src/companion/server.ts'),'utf8');
  ok(/routePath === "\/whatsapp\/rooms\/send-approvals"[\s\S]{0,400}x-clawmobile-owner-flow"\]!=="v1"/.test(server));
  ok(fs.readFileSync(path.join(__dirname,'../../installer/termux-lite/companion-acceptance.py'),'utf8').includes('("POST", "/whatsapp/rooms/send-approvals")'));

  // ---- 3. Paired with the playbooks room owner: the host's exact payloads, one shared dialogue store -------------
  const peer=process.env.ROOM_PLAYBOOKS_ROOT;
  if(peer){
    const store=fs.mkdtempSync(path.join(os.tmpdir(),'room-send-dialogue-'));fs.chmodSync(store,0o700);
    let log;
    const owner=input=>JSON.parse(execFileSync('python3',[path.join(__dirname,'lib/room-send-approval-paired.py'),peer,log],
      {input,encoding:'utf8',timeout:120000,env:{...process.env,CLAW_DIALOGUE_HOME:store}}));
    const sent=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
    for(const decision of ['confirm','refuse']){
      log=path.join(store,decision+'-dispatch.jsonl');
      const hp=[],askedBodies=[];
      const tool=brain.createRoomTools(ctx(),{home,readGrant:async()=>grantValue(),
        runTyped:async input=>{hp.push(JSON.parse(input));return owner(input);},
        requestOwnerApproval:async b=>{askedBodies.push(b);return {state:'awaiting_owner',reply:pending};}}).find(t=>t.name==='samantha_whatsapp');
      r=await call({tool},SEND);
      eq([r.body.state,hp.length,sent().length],['PENDING_OWNER',1,0],'prepared in the room owner, nothing sent');
      eq(askedBodies[0].parameters,SEND.params,'Amine is asked the bound command of the room owner');
      // Without Amine's confirmation the room owner itself refuses the hand-off.
      const bare={command:{domain:'whatsapp',operation:'handoff',goalRef:askedBodies[0].goalRef},host:hp[0].host,
        roomAdmission:brain.roomGrantPacket(require('../dist/contactRoomProfile.js').contactRoomPrincipal(agent,sessionKey,'messages'),
          hp[0].host.userRunId+':'+hp[0].host.invocationId,grantValue())};
      eq(owner(JSON.stringify(bare)).error,'typed_room_owner_confirmation_required');eq(sent().length,0);
      // Real clock here: the room owner admits the packet against the current time.
      const c2={told:[],...core(Date.now)};c2.c=c2.core;
      c2.a=approvals.createRoomSendApprovals({confirmations:c2.c,timer:()=>({}),readGrant:async()=>grantValue(),
        runTyped:async input=>owner(input),sendContact:async p=>{c2.told.push(p);return {};},notifyOwner:async()=>true});
      asked=await c2.a.request(askedBodies[0]);
      if(decision==='confirm')await sign(c2.c,asked.confirmationRequestId);else await c2.c.cancel(asked.confirmationRequestId);
      const out=await c2.a.decided(asked.confirmationRequestId);
      if(decision==='confirm'){
        eq([out.state,sent().map(s=>s[1])],['sent',['send_owner.py']]);
        eq(sent()[0].slice(2),[SEND.params.recipient,SEND.params.message],'exactly the confirmed text');
        eq(c2.told[0].message,approvals.ROOM_SEND_TEXTS.confirmed('Sadok'));
        await c2.a.decided(asked.confirmationRequestId);eq(sent().length,1,'never twice');
      }else{eq([out.reason,sent().length],['owner_refused',0],'a refused send never leaves');}
    }
    fs.rmSync(store,{recursive:true,force:true});
    console.log('paired with playbooks room owner at',peer);
  }
  console.log(`Room send approval: ${checks} checks passed`);
  fs.rmSync(home,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=1;});
