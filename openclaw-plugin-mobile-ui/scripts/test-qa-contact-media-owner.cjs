// Public SDK contract, synthetic bytes, real host FD reader; no S24 effects.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {handleQaContactMediaReceived}=require('../dist/qaContactMediaOwner');
let n=0;const check=f=>{f();n++;};
(async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qa-media-owner-'));try{
 const root=path.join(dir,'inbound');await fs.mkdir(root);const file=path.join(root,'fixture.txt'),bytes=Buffer.from('synthetic public fixture');await fs.writeFile(file,bytes);
 const ctx={channelId:'whatsapp',accountId:'fixture',sessionKey:'agent:contacts-qa:whatsapp:direct:+15555550123',messageId:'fixture-message',senderId:'fixture-sender'};
 const event={...ctx,from:'fixture',content:'never forward caption',metadata:{senderE164:'+15555550123'},media:[{path:file,messageId:ctx.messageId,contentType:'text/plain'}]};
 let calls=[],consumed;
 const deps={people:async(action,body,mutation,privateRead,c)=>{calls.push('authority');assert.equal(action,'qa-ingress-read');assert.equal(mutation,false);assert.equal(privateRead,true);assert.deepEqual(Object.keys(body),['requester_hash']);assert(c.signal instanceof AbortSignal&&c.remaining_ms<=10000);return{ok:true,grants:[{app_id:'fixture-app',grant_revision:'fixture-revision'}]};},attachment:async(mode,body,c)=>{calls.push(mode);assert(c.remaining_ms>0&&c.remaining_ms<=10000);if(mode==='admit')return{ok:true,admission:{context:{...body.context,selected_app_id:'fixture-app'},run_id:'qa-fixture',selected_app_id:'fixture-app',state:'DRAFT',plan_version:0}};consumed={body,bytes:Buffer.from(c.content)};return{state:'imported'};},media:async()=>{calls.push('sdk');return{resolveMediaBufferPath:async(id,subdir)=>{calls.push('resolve');assert.equal(id,'fixture.txt');assert.equal(subdir,'inbound');return file;}};}};
 let r=await handleQaContactMediaReceived(event,ctx,deps);
 check(()=>assert.deepEqual(r,{state:'imported',reason:null,imported:1}));check(()=>assert.deepEqual(calls,['authority','admit','sdk','resolve','authority','admit','authority','admit','consume']));check(()=>assert.deepEqual(consumed.bytes,bytes));check(()=>assert.equal(consumed.body.metadata.transport_event_id,createHash('sha256').update(ctx.messageId).digest('hex')));check(()=>assert.equal(consumed.body.metadata.name,'QA_Piece_1.txt'));check(()=>assert(!JSON.stringify(consumed.body).includes(file)&&!JSON.stringify(consumed.body).includes('never forward')));
 calls=[];r=await handleQaContactMediaReceived(event,ctx,{...deps,people:async()=>({ok:false})});check(()=>assert.equal(r.state,'blocked'));check(()=>assert.deepEqual(calls,[]));
 for(const change of [{mediaStagingPending:true},{messageId:undefined},{sessionKey:'agent:contacts-qa:whatsapp:group:fixture'},{media:[{url:'https://example.invalid/a',messageId:ctx.messageId,contentType:'text/plain'}]}]){calls=[];r=await handleQaContactMediaReceived({...event,...change},ctx,deps);check(()=>assert.equal(r.state,'blocked'));check(()=>assert(!calls.includes('consume')));}
 for(const canonical of [path.join(dir,'outside','fixture.txt'),path.join(root,'other.txt')]){calls=[];r=await handleQaContactMediaReceived(event,ctx,{...deps,media:async()=>({resolveMediaBufferPath:async()=>canonical})});check(()=>assert.equal(r.state,'blocked'));check(()=>assert(!calls.includes('consume')));}
 let reads=0;calls=[];r=await handleQaContactMediaReceived(event,ctx,{...deps,people:async(...args)=>++reads===3?{ok:false}:deps.people(...args)});check(()=>assert.equal(r.reason,'qa_media_authority_changed'));check(()=>assert(!calls.includes('consume')));
 let admissions=0;calls=[];r=await handleQaContactMediaReceived(event,ctx,{...deps,attachment:async(...args)=>{const result=await deps.attachment(...args);if(args[0]==='admit'&&++admissions===3)result.admission.plan_version++;return result;}});check(()=>assert.equal(r.reason,'qa_media_authority_changed'));check(()=>assert(!calls.includes('consume')));
 r=await handleQaContactMediaReceived(event,ctx,{...deps,attachment:async(...args)=>args[0]==='consume'?{state:'invented'}:deps.attachment(...args)});check(()=>assert.equal(r.state,'unknown'));
 const ownerModule=require('../dist/qaContactMediaOwner'),original=ownerModule.handleQaContactMediaReceived;let observed;
 ownerModule.handleQaContactMediaReceived=async(e,c)=>{observed={e,c};return {state:'ignored'};};
 try{const hooks=[];require('../dist/index').register({on(name,fn){hooks.push([name,fn]);},registerTool(){},logger:{}});
  const received=hooks.filter(([name])=>name==='message_received');check(()=>assert.equal(received.length,1));
  await received[0][1](event,ctx);check(()=>assert.deepEqual(observed,{e:event,c:ctx}));
  check(()=>assert.equal(hooks.filter(([name])=>name==='before_dispatch').length,1));
 }finally{ownerModule.handleQaContactMediaReceived=original;}
 console.log(`${n}/${n} factory/host checks passed; synthetic files, public SDK contract, no S24 effects`);
}finally{await fs.rm(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
