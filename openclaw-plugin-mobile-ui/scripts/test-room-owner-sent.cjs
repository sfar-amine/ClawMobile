// Amine 05/11 — a message sent to a room contact on Amine's behalf reaches that room's next turn as context.
// Real fixtures: the S24 people-trusted grant of the recette contact (fictitious number) and the public OpenClaw
// 2026.10.9 modules that own next-turn injections (host-hook-state enqueue/drain, registry api wrapper), run in a VM with
// an in-memory session entry store. Covered: one enqueue with the exact key/text/metadata; duplicate messageId → same
// key, nothing added; drained once into the next turn's prependContext; no room, no session, injection disabled and
// invalid input are closed answers; roomSendApprovals tell() queues its notice on the room session, and never lets a
// context failure change the notice.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),
  zlib=require('node:zlib'),crypto=require('node:crypto');
const os=require('node:os');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'room-owner-sent-'));
process.env.HOME=home;process.env.OPENCLAW_STATE_DIR=path.join(home,'.openclaw');
const sent=require('../dist/roomOwnerSent.js');
const approvals=require('../dist/companion/roomSendApprovals.js');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-11-02-pulse-room-brain/room-grant-recette.json'),'utf8'));
const SDK=path.join(__dirname,'../fixtures/openclaw-2026.10.9-compat');
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const PLUGIN='openclaw-plugin-mobile-ui';

// ---- The public OpenClaw 2026.10.9 owner, byte-exact (npm archive sha256 43c61a00…04ab) --------------------------------
const hookState=zlib.gunzipSync(fs.readFileSync(path.join(SDK,'host-hook-state-D_zw_kUa.mjs.gz'))).toString('utf8');
eq(crypto.createHash('sha256').update(hookState).digest('hex'),'a562b3cd56a0941bdebcc70e11e04a4b44fee86a6f546431ced6d88e501ed382');
const registry=zlib.gunzipSync(fs.readFileSync(path.join(SDK,'registry-CTP8XMYJ.mjs.gz'))).toString('utf8');
eq(crypto.createHash('sha256').update(registry).digest('hex'),'3edab64b6e829364d4c95e025a67b1393b6bba57671c32ab5a6f077a6f66cdd7');
// The api wrapper refuses with the same empty result as a missing session when prompt injection is off: the plugin
// must read that setting itself to answer a distinct reason.
ok(/enqueueNextTurnInjection: async \(injection\) => \{\s*if \(params\.hookPolicy\?\.allowPromptInjection === false\)/.test(registry));
ok(registry.includes('return enqueuePluginNextTurnInjection({\n\t\t\t\t\t\t\tcfg: registryParams.runtime.config.current(),\n\t\t\t\t\t\t\tpluginId: record.id,'));
// No session entry creation in the session workflow facade (only the runtime agent store has createSessionEntry).
ok(!/workflow[\s\S]{0,200}createSessionEntry/.test(registry.slice(registry.indexOf('enqueueNextTurnInjection: async'),registry.indexOf('enqueueNextTurnInjection: async')+3000)));

function sdkStore(){
  const entries=new Map(),scopes=[];
  const update=async(scope,fn)=>{scopes.push({sessionKey:scope.sessionKey,agentId:scope.agentId});
    const entry=entries.get(scope.sessionKey);if(!entry)return {found:false};
    return {found:true,result:fn(entry),canonicalKey:scope.sessionKey};};
  const ctx={structuredClone,Date,Object,Array,Set,Number,String,JSON,
    normalizeOptionalString:v=>typeof v==='string'&&v.trim()?v.trim():undefined,isPromiseLike:v=>!!v&&typeof v.then==='function',
    createSubsystemLogger:()=>({warn(){},info(){}}),getPluginRegistryForContext:()=>({plugins:[{id:PLUGIN,status:'loaded'}]}),
    // runtime-U4i1bMh7.mjs buildPluginAgentTurnPrepareContext and hook-policy-decisions resolvePromptInjectionAllowed (2026.10.9)
    buildPluginAgentTurnPrepareContext:({queuedInjections})=>{const pre=[],app=[];for(const e of queuedInjections){
      if(e.placement!=='prepend_context'&&e.placement!=='append_context'||typeof e.text!=='string')continue;const t=e.text.trim();
      if(t)(e.placement==='prepend_context'?pre:app).push(t);}
      return {...pre.length?{prependContext:pre.join('\n\n')}:{},...app.length?{appendContext:app.join('\n\n')}:{}};},
    resolvePromptInjectionAllowed:p=>p?.allowPromptInjection!==false,
    isPluginJsonValue:v=>{try{return JSON.stringify(JSON.parse(JSON.stringify(v)))===JSON.stringify(v);}catch{return false;}},
    normalizeSessionEntrySlotKey:v=>v,randomUUID:()=>crypto.randomUUID(),
    readResolvedSessionEntryInWorker:async scope=>entries.get(scope.sessionKey),
    resolveSessionEntryAccessTarget:scope=>({entry:entries.get(scope.sessionKey)}),updateResolvedSessionEntry:update};
  const body=hookState.split('\n').filter(l=>!/^import |^export \{/.test(l)).join('\n');
  const sdk=vm.runInNewContext(body+'\n({enqueuePluginNextTurnInjection,drainPluginNextTurnInjectionContext});',ctx);
  return {entries,scopes,sdk};
}
// The registry api wrapper (2026.10.9) in front of the owner: hook policy first, then the owner with the current config.
function fakeApi(store,cfg){
  const calls=[];
  return {calls,api:{id:PLUGIN,config:cfg,runtime:{config:{current:()=>cfg}},session:{workflow:{enqueueNextTurnInjection:async injection=>{
    calls.push(injection);
    if(cfg.plugins?.entries?.[PLUGIN]?.hooks?.allowPromptInjection===false)return {enqueued:false,id:'',sessionKey:injection.sessionKey};
    return store.sdk.enqueuePluginNextTurnInjection({cfg,pluginId:PLUGIN,pluginName:'Mobile UI',injection});}}}}};
}
const contact=fixture.allowlist_get.contact;
const grant=(extra={})=>({success:true,state:'ok',receipt:null,...JSON.parse(JSON.stringify(contact)),...extra});
async function call(handler,params){
  let out;await handler({params,respond:(ok,payload,error)=>{out={ok,payload,error};}});return out;
}

(async()=>{
  // ---- 1. Valid owner send: one injection on the routed room session ---------------------------------------------------
  const agent=fixture.routed_agent,sessionKey=`agent:${agent}:whatsapp:direct:${contact.e164}`;
  const store=sdkStore();store.entries.set(sessionKey,{sessionId:'s-room',updatedAt:1});
  const cfg={plugins:{entries:{[PLUGIN]:{llm:{}}}}};
  const {api,calls}=fakeApi(store,cfg);
  const reads=[];
  const handler=sent.createOwnerSentHandler(api,{readGrant:async id=>{reads.push(id);return grant();},clock:()=>Date.parse('2026-11-05T10:00:00Z')});
  const input={e164:contact.e164,messageId:'3EB0C0FFEE0001',at:'2026-11-05T09:59:58Z',text:'  Je passe à 18 h, ça te va ?  '};
  let out=await call(handler,input);
  eq(out,{ok:true,payload:{enqueued:true,agentId:'contacts-projet-pulse',id:'owner-send:3EB0C0FFEE0001'},error:undefined});
  eq(reads,[contact.contactId],'one people-trusted grant read, by the contact id of this number');
  const text='[Message envoyé par Amine via Samantha · 2026-11-05T09:59:58Z · id 3EB0C0FFEE0001] « Je passe à 18 h, ça te va ? »';
  eq(calls,[{sessionKey,agentId:agent,text,idempotencyKey:'owner-send:3EB0C0FFEE0001',placement:'prepend_context',
    ttlMs:7*24*3600*1000,metadata:{messageId:'3EB0C0FFEE0001',at:'2026-11-05T09:59:58Z',source:'owner_via_samantha'}}]);
  const queued=store.entries.get(sessionKey).pluginNextTurnInjections[PLUGIN];
  eq(queued.length,1);eq([queued[0].id,queued[0].idempotencyKey,queued[0].text,queued[0].placement],
    ['owner-send:3EB0C0FFEE0001','owner-send:3EB0C0FFEE0001',text,'prepend_context']);
  eq(store.scopes.at(-1),{sessionKey,agentId:agent});

  // ---- 2. Duplicate messageId: same key, nothing added -----------------------------------------------------------------
  out=await call(handler,{...input,at:'2026-11-05T10:00:01Z'});
  eq(out.payload,{enqueued:false,reason:'already_enqueued_or_full',agentId:agent,id:'owner-send:3EB0C0FFEE0001'});
  eq(calls.at(-1).idempotencyKey,'owner-send:3EB0C0FFEE0001');
  eq(store.entries.get(sessionKey).pluginNextTurnInjections[PLUGIN].length,1);
  // A second message is a second record, in send order.
  out=await call(handler,{...input,messageId:'3EB0C0FFEE0002',text:'Et pense au code du portail.'});
  eq(out.payload.enqueued,true);

  // ---- 3. The next turn of that room session drains both, once, into prependContext ---------------------------------
  const drained=await store.sdk.drainPluginNextTurnInjectionContext({cfg,sessionKey,agentId:agent});
  eq(drained.prependContext,text+'\n\n[Message envoyé par Amine via Samantha · 2026-11-05T09:59:58Z · id 3EB0C0FFEE0002] « Et pense au code du portail. »');
  eq((await store.sdk.drainPluginNextTurnInjectionContext({cfg,sessionKey,agentId:agent})).queuedInjections.length,0);

  // ---- 4. Closed answers: no room, no session, allowlist down, prompt injection disabled, room changed -----------------
  const closed=async(read,extra={},params=input)=>{
    const s=sdkStore();s.entries.set(sessionKey,{sessionId:'s',updatedAt:1});const f=fakeApi(s,extra.cfg||cfg);
    const r=await call(sent.createOwnerSentHandler(f.api,{readGrant:read,clock:()=>Date.parse('2026-11-05T10:00:00Z')}),params);
    return {payload:r.payload,enqueues:f.calls.length,queued:s.entries.get(sessionKey).pluginNextTurnInjections};
  };
  for(const [name,value] of [['conversation only',grant({rooms:['conversation']})],['suspended',grant({state:'suspended'})],
      ['owner',grant({owner:true})],['expired',grant({expiresAt:'2026-11-01T00:00:00Z'})],['other number',grant({e164:'+21610000002'})],
      ['maison',grant({rooms:['maison']})]])
    eq(await closed(async()=>value),{payload:{enqueued:false,reason:'no_room'},enqueues:0,queued:undefined},name);
  eq((await closed(async()=>{throw Object.assign(Error('unknown_contact'),{statusCode:404});})).payload,{enqueued:false,reason:'no_room'});
  eq((await closed(async()=>{throw Object.assign(Error('allowlist_unavailable'),{statusCode:503});})).payload,
    {enqueued:false,reason:'allowlist_unavailable'});
  eq(await closed(async()=>grant(),{cfg:{plugins:{entries:{[PLUGIN]:{hooks:{allowPromptInjection:false}}}}}}),
    {payload:{enqueued:false,reason:'prompt_injection_disabled'},enqueues:0,queued:undefined});
  eq((await closed(async()=>grant(),{},{...input,sessionKey:`agent:contacts-messages:whatsapp:direct:${contact.e164}`})).payload,
    {enqueued:false,reason:'room_changed',agentId:agent});
  {
    const s=sdkStore(),f=fakeApi(s,cfg);// no entry: the contact never wrote to this room
    const r=await call(sent.createOwnerSentHandler(f.api,{readGrant:async()=>grant()}),input);
    eq(r.payload,{enqueued:false,reason:'no_session',agentId:agent});eq(s.entries.size,0,'no session entry is created');
  }
  {
    const r=await call(sent.createOwnerSentHandler({id:PLUGIN,config:cfg,session:{}},{readGrant:async()=>grant()}),input);
    eq(r.payload,{enqueued:false,reason:'injection_unavailable'});
  }

  // ---- 5. Invalid input is refused before any read -----------------------------------------------------------------
  let touched=0;const strict=sent.createOwnerSentHandler(api,{readGrant:async()=>{touched++;return grant();}});
  for(const bad of [null,[],{...input,extra:1},{e164:input.e164,messageId:'m',at:input.at},{...input,e164:'21610000001'},
      {...input,e164:'+0123'},{...input,messageId:'id with space'},{...input,messageId:'x'.repeat(201)},{...input,at:'05/11/2026'},
      {...input,at:'2026-13-45T99:99:99Z'},{...input,text:'   '},{...input,text:'x'.repeat(4001)},{...input,text:'a\u0000b'},
      {...input,text:42},{...input,source:'contact'},{...input,sessionKey:'agent:contacts-messages:whatsapp:direct:+21610000002'},
      {...input,sessionKey:'agent:main:whatsapp:direct:'+contact.e164}]){
    const r=await call(strict,bad);eq([r.ok,r.error?.code],[false,'INVALID_REQUEST'],JSON.stringify(bad)?.slice(0,80));
  }
  eq(touched,0);
  eq(sent.validateOwnerSent({...input,text:'x'.repeat(4000)}).text.length,4000);
  eq(Array.from(sent.boundOwnerSentText('é'.repeat(5000))).length,4000);

  // ---- 6. Registered on the Gateway with the write scope of the other plugin methods ---------------------------------
  const methods={};require('../dist/index.js').register({on(){},registerTool(){},logger:{},session:{},
    registerGatewayMethod(name,fn,opts){methods[name]={fn,opts};}});
  eq(methods[sent.ROOM_OWNER_SENT_METHOD].opts,{scope:'operator.write',profileAccess:'independent'});
  eq(sent.ROOM_OWNER_SENT_METHOD,'samantha.room.owner_sent');

  // ---- 7. roomSendApprovals tell(): the notice to the contact is queued on its room session, with its send key -------
  const roomAgent='contacts-messages',roomKey=`agent:${roomAgent}:whatsapp:direct:${contact.e164}`;
  const roomGrant=()=>grant({rooms:['conversation','messages']});
  function companion({sendFails=false,recordFails=false}={}){
    const s=sdkStore();s.entries.set(roomKey,{sessionId:'s-msg',updatedAt:1});const f=fakeApi(s,cfg);
    const method=sent.createOwnerSentHandler(f.api,{readGrant:async()=>roomGrant()});
    const told=[],recorded=[];let status='awaiting_owner';
    const confirmations={prepare:async()=>({state:'awaiting_owner',requestId:'req-1',expiresAt:Date.now()+120000}),
      status:async()=>({state:status}),cancel:async()=>{},consume:async()=>null,recordStep:async()=>{}};
    const a=approvals.createRoomSendApprovals({confirmations,timer:()=>({}),readGrant:async()=>roomGrant(),
      runTyped:async()=>({state:'CANCELLED'}),notifyOwner:async()=>true,
      sendContact:async p=>{told.push(p);if(sendFails)throw Error('send down');return {messageId:'m'};},
      recordSent:async p=>{recorded.push(p);if(recordFails)throw Error('gateway down');
        const r=await call(method,p);if(!r.ok)throw Error(r.error.code);return r.payload;}});
    return {a,s,told,recorded,refuse:()=>{status='cancelled';}};
  }
  const body={schemaVersion:1,goalRef:'goal-0123abcd',agentId:roomAgent,sessionKey:roomKey,userRunId:'run-1',invocationId:'call-1',
    accountId:null,parameters:{recipient:'Sadok',message:'J’arrive dans 10 minutes.'}};
  {
    const c=companion();await c.a.request(body);c.refuse();
    eq(await c.a.decided('req-1'),{state:'aborted',reason:'owner_refused'});
    eq(c.told.length,1);eq(c.recorded.length,1);
    const r=c.recorded[0];
    eq([r.e164,r.messageId,r.text,r.source,r.sessionKey],
      [contact.e164,c.told[0].idempotencyKey,approvals.ROOM_SEND_TEXTS.refused('Sadok'),'room_send_outcome',roomKey]);
    ok(/^samantha-room-send-[a-f0-9]{40}$/.test(r.messageId));ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.at));
    const q=c.s.entries.get(roomKey).pluginNextTurnInjections[PLUGIN];
    eq(q.length,1);eq(q[0].idempotencyKey,'owner-send:'+r.messageId);
    eq(q[0].text,`[Message envoyé au contact par Samantha · ${r.at} · id ${r.messageId}] « ${approvals.ROOM_SEND_TEXTS.refused('Sadok')} »`);
  }
  {
    const c=companion({recordFails:true});await c.a.request(body);c.refuse();
    eq(await c.a.decided('req-1'),{state:'aborted',reason:'owner_refused'},'a context failure never changes the outcome');
    eq([c.told.length,c.recorded.length],[1,1]);
  }
  {
    const c=companion({sendFails:true});await c.a.request(body);c.refuse();
    eq(await c.a.decided('req-1'),{state:'aborted',reason:'owner_refused'});
    eq([c.told.length,c.recorded.length],[1,0],'no context for a notice that was not sent');
  }
  console.log(JSON.stringify({ok:true,checks}));
})().catch(error=>{console.error(error);process.exit(1);}).finally(()=>fs.rmSync(home,{recursive:true,force:true}));
