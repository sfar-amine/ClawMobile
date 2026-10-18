// Synthetic sender/content; field names/types come from the installed public SDK capture.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {receiveQaContactMedia}=require('../dist/qaContactMediaIngress');
const hash=b=>createHash('sha256').update(b).digest('hex');
let checks=0;const check=fn=>{fn();checks++;};
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qa-contact-media-'));
 try {
  const root=path.join(directory,'inbound');await fs.mkdir(root,{mode:0o700});
  const source=path.join(root,'original-private-name.txt'),content=Buffer.from('synthetic text fixture');await fs.writeFile(source,content);
  const ctx={channelId:'whatsapp',accountId:'synthetic-account',sessionKey:'agent:contacts-qa:whatsapp:direct:+15555550123',messageId:'synthetic-message',senderId:'synthetic-sender'};
  const event={from:'synthetic-from',content:'caption is never forwarded',sessionKey:ctx.sessionKey,messageId:ctx.messageId,senderId:ctx.senderId,
   metadata:{senderE164:'+15555550123'},media:[{path:source,contentType:'text/plain',messageId:ctx.messageId}]};
  let admits=0,consumes=0,last;
  const admission=i=>({context:{schema_version:1,access_class:'qa_room',requester_hash:i.requester_hash,thread_ref:i.thread_ref,conversation_kind:'direct',transport_event_id:i.transport_event_id,owner:false,selected_app_id:'fixture-app',grants:[{app_id:'fixture-app',grant_revision:'synthetic-revision'}]},run_id:'qa-fixture',selected_app_id:'fixture-app',state:'DRAFT',plan_version:0});
  const owners={admit:async(i,control)=>{admits++;assert(control.remaining_ms>0&&control.remaining_ms<=10000);return admission(i);},inboundRoot:async()=>root,
   consume:async(a,m,b)=>{consumes++;last={a,m,b:Buffer.from(b)};return {state:'imported'};}};
  let result=await receiveQaContactMedia(event,ctx,owners);
  check(()=>assert.deepEqual(result,{state:'imported',reason:null,imported:1}));
  check(()=>assert.equal(admits,3));
  check(()=>assert.deepEqual(last.b,content));
  check(()=>assert.deepEqual(Object.keys(last.m).sort(),['app_id','message_id','mime_type','name','requester_hash','schema_version','sha256','size_bytes','transport_event_id']));
  check(()=>assert.equal(last.m.name,'QA_Piece_1.txt'));
  check(()=>assert.equal(last.m.sha256,hash(content)));
  check(()=>assert(!JSON.stringify(last.m).includes(source)&&!JSON.stringify(last.m).includes('original-private-name')));
  for(const change of [{messageId:'other'}, {sessionKey:'agent:contacts-qa:whatsapp:group:fixture'}, {senderId:'different'}, {metadata:{senderE164:'+15555550999'}}]) {
   const count=consumes;result=await receiveQaContactMedia({...event,...change},ctx,owners);
   check(()=>assert.equal(result.reason,'qa_media_identity_unavailable'));check(()=>assert.equal(consumes,count));
  }
  result=await receiveQaContactMedia({...event,mediaStagingPending:true,originalMedia:event.media},ctx,owners);
  check(()=>assert.equal(result.reason,'qa_media_staging_pending'));
  result=await receiveQaContactMedia({...event,media:undefined,originalMedia:event.media},ctx,owners);
  check(()=>assert.equal(result.state,'ignored'));
  result=await receiveQaContactMedia({...event,media:Array(5).fill(event.media[0])},ctx,owners);
  check(()=>assert.equal(result.reason,'qa_media_volume_refused'));
  for(const fact of [{...event.media[0],messageId:'other'}, {...event.media[0],contentType:'audio/ogg'},
   {...event.media[0],contentType:'application/pdf'}, {url:'https://example.invalid/no-download',contentType:'text/plain',messageId:ctx.messageId}]) {
   const count=consumes;result=await receiveQaContactMedia({...event,media:[fact]},ctx,owners);
   check(()=>assert.equal(result.state,'blocked'));check(()=>assert.equal(consumes,count));
  }
  result=await receiveQaContactMedia(event,ctx,{...owners,admit:async()=>null,inboundRoot:async()=>{throw Error('must not read root');}});
  check(()=>assert.equal(result.reason,'qa_media_campaign_unavailable'));
  result=await receiveQaContactMedia(event,ctx,{...owners,admit:async i=>({...admission(i),state:'READY'})});
  check(()=>assert.equal(result.reason,'qa_media_campaign_unavailable'));
  result=await receiveQaContactMedia(event,ctx,{...owners,admit:async i=>{const a=admission(i);a.context.grants=[];return a;}});
  check(()=>assert.equal(result.reason,'qa_media_campaign_unavailable'));
  const outside=path.join(directory,'outside.txt');await fs.writeFile(outside,'not imported');
  const link=path.join(root,'symlink.txt');await fs.symlink(outside,link);
  result=await receiveQaContactMedia({...event,media:[{...event.media[0],path:link}]},ctx,owners);
  check(()=>assert.equal(result.reason,'qa_media_path_refused'));
  result=await receiveQaContactMedia({...event,media:[{...event.media[0],path:outside}]},ctx,owners);
  check(()=>assert.equal(result.reason,'qa_media_path_refused'));
  const nested=path.join(root,'nested');await fs.mkdir(nested);await fs.writeFile(path.join(nested,'other.txt'),'not a flat SDK ID');
  result=await receiveQaContactMedia({...event,media:[{...event.media[0],path:path.join(nested,'other.txt')}]},ctx,owners);
  check(()=>assert.equal(result.reason,'qa_media_path_refused'));
  const hard=path.join(root,'hardlink.txt');await fs.link(source,hard);
  result=await receiveQaContactMedia(event,ctx,owners);check(()=>assert.equal(result.reason,'qa_media_volume_refused'));await fs.unlink(hard);
  let round=0,count=consumes;
  result=await receiveQaContactMedia(event,ctx,{...owners,admit:async i=>++round===3?null:admission(i)});
  check(()=>assert.equal(result.reason,'qa_media_authority_changed'));check(()=>assert.equal(consumes,count));
  result=await receiveQaContactMedia(event,ctx,{...owners,consume:async()=>{throw Error('PRIVATE_RAW_ERROR');}});
  check(()=>assert.equal(result.state,'unknown'));check(()=>assert(!JSON.stringify(result).includes('PRIVATE_RAW_ERROR')));
  const both={...event,media:[event.media[0],event.media[0]]};
  result=await receiveQaContactMedia(both,ctx,owners);
  check(()=>assert.equal(result.imported,2));
  for(const changed of [{plan_version:1},{dossier_version:'v-'+'a'.repeat(24)}]){
   let rounds=0;const count=consumes;
   result=await receiveQaContactMedia(event,ctx,{...owners,admit:async i=>({...admission(i),...(++rounds===3?changed:{})})});
   check(()=>assert.equal(result.reason,'qa_media_authority_changed'));check(()=>assert.equal(consumes,count));
  }
  const mutable={...event,media:[{...event.media[0]}]};
  result=await receiveQaContactMedia(mutable,ctx,{...owners,admit:async i=>{mutable.media.push(event.media[0]);return admission(i);}});
  check(()=>assert.equal(result.imported,1)); // The bounded source fact snapshot cannot grow across awaits.
  const big=path.join(root,'large.txt'),handle=await fs.open(big,'w');await handle.truncate(20*1024*1024+1);await handle.close();
  result=await receiveQaContactMedia({...event,media:[{...event.media[0],path:big}]},ctx,owners);
  check(()=>assert.equal(result.reason,'qa_media_volume_refused'));
  // Real deadline/cancellation, no process or phone calls. The callback is read-only.
  let signal;
  const start=Date.now();result=await receiveQaContactMedia(event,ctx,{...owners,admit:async(_i,c)=>{signal=c.signal;return new Promise(()=>{});}});
  check(()=>assert.equal(result.reason,'qa_media_deadline_exceeded'));
  check(()=>assert(signal.aborted&&Date.now()-start>=9900&&Date.now()-start<12000));
  const capture=JSON.parse(await fs.readFile(path.resolve(__dirname,'../fixtures/qa/message-received-sdk-public-20261018.json')));
  check(()=>assert.equal(capture.sha256,'d066e0a30921eb05d79f7ef6b7f425b7e1628b912634b660b13ac324e6bb7c1d'));
  for(const name of ['PluginHookMessageReceivedEvent','PluginHookMessageContext','MessageHookMediaFact'])check(()=>assert(capture.blocks.some(b=>b.name===name&&!b.truncated)));
  const received=capture.blocks.find(b=>b.name==='PluginHookMessageReceivedEvent');
  check(()=>assert(!received.source.some(s=>s.text.includes('isGroup'))));
  check(()=>assert(capture.mapper_provenance.source.some(s=>s.text.includes('senderE164: ctx.SenderE164'))));
  console.log(`${checks}/${checks} host media checks passed; inert hook, synthetic bytes, no S24 effects`);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
