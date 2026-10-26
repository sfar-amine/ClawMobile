// Execute captured native mapper/identity/publisher functions, not authored copies of their behavior.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),vm=require('node:vm'),crypto=require('node:crypto');
const dir=path.join(__dirname,'../fixtures/s24-2026-10-26-native-sdk/compat');
const manifest=require('../../installer/termux-lite/openclaw-compat/native-turn-provenance.json');
const read=name=>zlib.gunzipSync(fs.readFileSync(path.join(dir,name+'.gz'))).toString();
const source=name=>{
 let text=read(name);const entry=manifest.files.find(f=>f.path==='dist/'+name);
 if(entry){assert.equal(crypto.createHash('sha256').update(text).digest('hex'),entry.original);
  for(const [before,after] of entry.replacements){assert.equal(text.split(before).length,2);text=text.replace(before,after)}
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'),entry.patched);
 }return text;
};
function fn(text,name){const pattern=new RegExp('(?:async )?function '+name+'\\('),m=pattern.exec(text);assert(m,name);
 const ends=['\nfunction ','\nasync function ','\n//#endregion'].map(s=>text.indexOf(s,m.index+m[0].length)).filter(i=>i>=0);
 return text.slice(m.index,ends.length?Math.min(...ends):text.length);
}
(async()=>{
 const id='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';let minted=0;
 const normalize=v=>typeof v==='string'&&v.trim()?v.trim():undefined;
 const sandbox={process:{hrtime:{bigint:()=>100000000000n}},crypto:{randomUUID(){minted++;return id}},normalizeOptionalString:normalize,readNonBlankString:normalize,
  normalizeLowercaseStringOrEmpty:v=>String(v||'').trim().toLowerCase(),normalizeMediaFacts:()=>[],
  internalSessionConversationId:()=>undefined,freezeDiagnosticTraceContext:x=>x,
  normalizeChannelId:v=>v,getChannelPlugin:()=>undefined,stripChannelPrefix:v=>v,
  structuredClone,resolveGlobalSet:()=>new Set(),resolveGlobalSingleton:(_key,make)=>make(),
  asPositiveSafeInteger:v=>Number.isSafeInteger(v)&&v>0?v:undefined,isRecord:v=>!!v&&typeof v==='object'&&!Array.isArray(v),
  parseAgentSessionKey:()=>({agentId:'main'})};
 vm.createContext(sandbox);
 vm.runInContext(read('message-hook-mappers-RPSrPEKP.mjs').replace(/^import .*;\r?\n/gm,'').replace(/^export .*;\s*$/gm,''),sandbox);
 vm.runInContext(fn(source('dispatch-from-config-Cu599NRF.mjs'),'prepareNativeInboundRunOptions'),sandbox);
 const params={body:'authored'},options=sandbox.prepareNativeInboundRunOptions(params);
 assert.equal(options.runId,id);assert.equal(minted,1);assert.equal(params.runId,undefined);
 const provided=sandbox.prepareNativeInboundRunOptions({runId:target,admission:params});
 assert.equal(provided.runId,target);assert.equal(provided.admission,params);assert.equal(minted,1);
 sandbox.ctx={Provider:'whatsapp',SessionKey:'agent:main:whatsapp:direct:+19995550123',MessageSid:'authored-source-id',Body:'authored text'};
 sandbox.messageIdForHook='authored-source-id';sandbox.normalizedParams={replyOptions:options};
 const dispatch=source('dispatch-from-config-Cu599NRF.mjs'),start=dispatch.indexOf('const buildHookState = (sourceCtx) => {'),end=dispatch.indexOf('\n\tconst hookState =',start);
 assert(start>=0&&end>start);vm.runInContext(dispatch.slice(start,end)+'\nglobalThis.buildCapturedHookState=buildHookState;',sandbox);
 const before=sandbox.deriveInboundMessageHookContext(sandbox.ctx);assert.equal(before.runId,undefined,'captured unpatched mapper reproduces the runtime/type gap');
 const native=sandbox.buildCapturedHookState(sandbox.ctx).hookContext;
 assert.equal(sandbox.toPluginMessageReceivedEvent(native).runId,id);assert.equal(sandbox.toPluginMessageContext(native).runId,id);
 // Evaluate the actual added native transport/followup properties and existing queued-run expression.
 const reply=source('get-reply-DXzvDRjY.mjs'),property=reply.split('\n').find(l=>l.includes('ingressRunId: opts.runId'));
 sandbox.opts=options;const ingress=vm.runInContext('({'+property.trim()+'})',sandbox);assert.equal(ingress.ingressRunId,id);
 const runner=source('agent-runner.runtime-DH-TOu7I.mjs'),queuedLine=runner.split('\n').find(l=>l.includes('runId:')&&l.includes('queued.ingressRunId'));
 sandbox.queued=ingress;assert.equal(vm.runInContext('({'+queuedLine.trim()+'})',sandbox).runId,id);assert.equal(minted,1,'followup reuses the same native ingress UUID');
 sandbox.queued={ingressRunId:'authored-invalid'};vm.runInContext('({'+queuedLine.trim()+'})',sandbox);assert.equal(minted,2,'legacy/invalid queue identity uses the original UUID owner');
 let admissions=0,released=0,completed=0;const beforeRefreshMint=minted;
 sandbox.DispatchSessionRefreshRequiredError=class extends Error {};
 sandbox.REPLY_ADMISSION_TICKET=Symbol('authored-ticket');
 sandbox.reserveReplyAdmissionTicket=()=>({release(){released++}});
 sandbox.createInboundMessageAuditTerminal=()=>({finishSuccess(){completed++},finishError(){throw Error('unexpected terminal error')}});
 sandbox.dispatchReplyFromConfigInner=async p=>{admissions++;assert.equal(p.replyOptions.runId,id);
  if(admissions===1)throw new sandbox.DispatchSessionRefreshRequiredError();return 'authored-success';};
 vm.runInContext(fn(dispatch,'dispatchReplyFromConfigWithQueuePolicy'),sandbox);
 assert.equal(await sandbox.dispatchReplyFromConfigWithQueuePolicy({ctx:{SessionKey:sandbox.ctx.SessionKey}},true),'authored-success');
 assert.equal(admissions,2);assert.equal(minted,beforeRefreshMint+1,'a native session-refresh retry keeps the original ingress UUID');
 assert.equal(released,1);assert.equal(completed,1);
 vm.runInContext(read('transcript-events-DukKauix.mjs').replace(/^import .*;\r?\n/gm,'').replace(/^export .*;\s*$/gm,''),sandbox);
 const updates=[];const unsubscribe=sandbox.onSessionTranscriptUpdate(e=>updates.push(e));
 const metadata=read('user-turn-transcript.metadata-BY4PdwgQ.mjs');
 vm.runInContext('const STEER_TARGET_RUN_ID_MAX_CHARS=512;\n'+fn(metadata,'normalizePersistedSteerTargetRunId')+'\n'+fn(metadata,'rewritePersistedSteerTargetRunId'),sandbox);
 sandbox.asOptionalRecord=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:undefined;
 sandbox.normalizeInputProvenance=()=>undefined;sandbox.isDeepStrictEqual=require('node:util').isDeepStrictEqual;
 vm.runInContext(['readTranscriptSenderIdentity','applyTranscriptSenderIdentityToWrite','preparePersistedUserTurnMessageForTranscriptWrite'].map(n=>fn(metadata,n)).join('\n'),sandbox);
 const protectedInput={role:'user',__openclaw:{senderIsOwner:true,transport:{channel:'whatsapp',...ingress}}};
 const protectedOutput=sandbox.preparePersistedUserTurnMessageForTranscriptWrite(protectedInput,{beforeMessageWrite:()=>({role:'user',__openclaw:{senderIsOwner:false,transport:{channel:'whatsapp',ingressRunId:target},steerTargetRunId:target}})});
 assert.equal(protectedOutput.__openclaw.transport.ingressRunId,id);assert.equal(protectedOutput.__openclaw.transport.ingressObservedMonoMs,100000);assert.equal(protectedOutput.__openclaw.senderIsOwner,true);
 assert.equal(protectedOutput.__openclaw.steerTargetRunId,undefined,'a hook cannot manufacture the post-consumption binding');

 let release;const gate=new Promise(r=>release=r);const original={role:'user',__openclaw:{senderIsOwner:true,transport:{channel:'whatsapp',...ingress}}};
 sandbox.isUserMessage=m=>m?.role==='user';
 sandbox.rewriteTranscriptMessageAtAnchor=async(_anchor,edit)=>{await gate;return {generation:2,message:edit(original)}};
 sandbox.publishTranscriptUpdate=async(_anchor,update)=>sandbox.emitSessionTranscriptUpdate({...update,target:{agentId:'main',sessionKey:sandbox.ctx.SessionKey,sessionId:'authored-session'}});
 vm.runInContext(fn(read('user-turn-transcript-BkLX9Oj1.mjs'),'confirmPersistedSteerTargetRunId'),sandbox);
 const confirmation=sandbox.confirmPersistedSteerTargetRunId({targetRunId:target,admission:{entryId:'authored-anchor',activeMessagePosition:2}});
 assert.equal(updates.length,0,'no adoption callback before exact-anchor persistence completes');release();await confirmation;
 assert.equal(updates.length,1);assert.equal(updates[0].message.__openclaw.transport.ingressRunId,id);
 assert.equal(updates[0].message.__openclaw.transport.ingressObservedMonoMs,100000);assert.equal(updates[0].message.__openclaw.steerTargetRunId,target);assert.equal(updates[0].messageSeq,3);
 assert.equal(original.__openclaw.steerTargetRunId,undefined);
 // Original admitted users also publish inline before the principal response, independent of WA received opt-in.
 sandbox.readCommittedTranscriptMessageSequence=()=>undefined;
 vm.runInContext(fn(read('session-accessor-DLYTHSBj.mjs'),'publishTranscriptTurnUpdate'),sandbox);
 const normalMessage={role:'user',__openclaw:{senderIsOwner:true,transport:{channel:'whatsapp',...ingress}}};
 await sandbox.publishTranscriptTurnUpdate({target:{agentId:'main',sessionId:'authored-session',sessionKey:sandbox.ctx.SessionKey},
  updateMode:'inline',publishWhen:'when-appended',appendedMessages:[{appended:true,message:normalMessage,messageId:'authored-original-anchor'}]});
 assert.equal(updates.length,2);assert.equal(updates[1].message.__openclaw.transport.ingressRunId,id);
 assert.equal(updates[1].messageSeq,undefined,'optional native sequence is never invented');
unsubscribe();
 console.log('native turn provenance: real missing-UUID regression, one identity through mapper/direct/followup and public confirmed-adoption pair PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
