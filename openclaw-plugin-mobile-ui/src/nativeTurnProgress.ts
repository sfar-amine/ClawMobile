/** SDK observations only. All durable writes/deadlines stay in the existing Companion run owner. */
import http from 'http';
import {ownerWhatsAppNumbers} from './modelFastPath';
const SESSION=/^agent:main:whatsapp:direct:(\+?[1-9][0-9]{7,14})$/;
const RUN=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Context={runId?:string;sessionKey?:string;channelId?:string;channel?:string;messageProvider?:string;agentId?:string;
 modelProviderId?:string;modelId?:string;accountId?:string};
function postObservation(runId:string,body:unknown):Promise<any>{
 const encoded=JSON.stringify(body);return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:Number(process.env.CLAWMOBILE_COMPANION_PORT)||8765,
   path:'/v1/runs/'+encodeURIComponent(runId)+'/measurement',method:'POST',headers:{'Content-Type':'application/json',
    'Content-Length':Buffer.byteLength(encoded),'X-Clawmobile-Owner-Flow':'v1'}},res=>{
   let bytes=0,raw='';res.on('data',part=>{bytes+=part.length;if(bytes>4096){req.destroy(Error('measurement_response_too_large'));return;}raw+=part;});
   res.on('end',()=>{try{const value=JSON.parse(raw);if((res.statusCode||500)>=400)reject(Error('measurement_unavailable'));else resolve(value);}catch{reject(Error('measurement_invalid_response'));}});
  });req.setTimeout(1500,()=>req.destroy(Error('measurement_timeout')));req.on('error',reject);req.end(encoded);
 });
}
function nativePeer(ctx:Context,owners:()=>Set<string>){
 // AgentContext.channelId is the target/chat ID, while MessageContext.channelId is the channel.
 if((ctx.channel||ctx.messageProvider||ctx.channelId)!=='whatsapp'||ctx.agentId&&ctx.agentId!=='main')return false;
 const match=SESSION.exec(ctx.sessionKey||'');return !!match&&owners().has(match[1].startsWith('+')?match[1]:'+'+match[1]);
}
/** L3 causal provenance with L4 stage/delivery observations; the same Companion owner persists both. */
export function nativeTurnProgressHooks(deps:{owners?:()=>Set<string>;post?:(id:string,body:any)=>Promise<any>;enabled?:()=>boolean}={}){
 const owners=deps.owners||ownerWhatsAppNumbers,post=deps.post||postObservation,enabled=deps.enabled||(()=>process.env.SAMANTHA_BRAIN_ONLY==='1');
 const valid=(event:any,ctx:Context)=>enabled()&&nativePeer(ctx,owners)&&RUN.test(ctx.runId||event?.runId||'')&&
  !(ctx.runId&&event?.runId&&ctx.runId!==event.runId)&&!(event?.sessionKey&&event.sessionKey!==ctx.sessionKey);
 const model=(event:any,ctx:Context)=>{const m=typeof event?.model==='string'?event.model:ctx.modelId,p=typeof event?.provider==='string'?event.provider:ctx.modelProviderId;
  return typeof m==='string'?(m.includes('/')?m:typeof p==='string'?p+'/'+m:undefined):undefined;};
 return {
  async received(event:any,ctx:Context){if(!valid(event,ctx))return;
   await post(ctx.runId||event.runId,{operation:'native_ingress',sessionKey:ctx.sessionKey,accountId:ctx.accountId,
    observedMonoMs:Number(process.hrtime.bigint()/1000000n)}).catch(()=>{});
  },
  async ended(event:any,ctx:Context){if(!valid(event,ctx)||typeof event?.success!=="boolean")return;
   await post(ctx.runId||event.runId,{operation:'native_end',sessionKey:ctx.sessionKey,model:model(event,ctx),success:event?.success!==false}).catch(()=>{});
  },
  async sent(event:any,ctx:Context){if(!valid(event,ctx)||event?.success!==true)return;
   // No runId means unqualified; never substitute the latest turn from this session.
   await post(event.runId||ctx.runId!,{operation:'native_delivery',sessionKey:ctx.sessionKey}).catch(()=>{});
  },
  async stage(event:any,ctx:Context,kind:'model'|'tool'){
   if(!valid(event,ctx)||kind==='tool'&&!(typeof event?.toolName==='string'&&event.toolName.startsWith('samantha_')))return;
   let outcome:string|undefined;
   if(kind==='tool')try{const result=event?.result;const value=Array.isArray(result?.content)&&typeof result.content[0]?.text==='string'?JSON.parse(result.content[0].text):result;
    if(['NEEDS_INPUT','NEEDS_CHOICE','NEEDS_CONFIRMATION','COMPLETED','FAILED','DENIED','OUTSIDE_SCOPE','UNRESOLVED','TECHNICAL_FAILURE','WAITING_OPERATION'].includes(value?.state))outcome=value.state;}catch{}
   await post(ctx.runId||event.runId,{operation:'native_stage',sessionKey:ctx.sessionKey,kind,
    durationMs:Number.isSafeInteger(event?.durationMs)&&event.durationMs>=0?event.durationMs:null,model:model(event,ctx),outcome}).catch(()=>{});
  },
 };
}
export type NativeObservedRun={runId:string;sessionKey:string;clockEpoch:string;deadlineAt:number;state:"running";observationSource:"sdk_message_received"};
/** Read-only adapter to the same owner. Not an abort authority or a candidate-selection heuristic. */
export async function activeObservedNativeWhatsAppRun(sessionKey:string,options:{excludeRunId?:string}={}):Promise<NativeObservedRun|null>{
 const id=options.excludeRunId||'native-observation';if(options.excludeRunId!==undefined&&!RUN.test(options.excludeRunId)||!SESSION.test(sessionKey))return null;
 try{
  const response=await postObservation(id,{operation:'native_active',sessionKey,excludeRunId:options.excludeRunId}),v=response?.active;
  if(!v||typeof v.runId!=='string'||!RUN.test(v.runId)||v.sessionKey!==sessionKey||v.state!=='running'||
    typeof v.clockEpoch!=='string'||!Number.isFinite(v.deadlineAt)||v.observationSource!=='sdk_message_received')return null;
  return {runId:v.runId,sessionKey:v.sessionKey,clockEpoch:v.clockEpoch,deadlineAt:v.deadlineAt,state:'running',observationSource:'sdk_message_received'};
 }catch{return null;}
}
