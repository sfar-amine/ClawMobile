/** SDK observations only. All durable writes/deadlines stay in the existing Companion run owner. */
import http from 'http';
import {ownerWhatsAppNumbers} from './modelFastPath';
const SESSION=/^agent:main:whatsapp:direct:(\+?[1-9][0-9]{7,14})$/;
const RUN=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Context={runId?:string;sessionKey?:string;channelId?:string;channel?:string;messageProvider?:string;agentId?:string;
 modelProviderId?:string;modelId?:string;accountId?:string};
let observationPosts=0;
function postObservation(runId:string,body:unknown):Promise<any>{
 const encoded=JSON.stringify(body);
 if(observationPosts>=32)return Promise.reject(Error('observation_capacity'));
 observationPosts++;
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:Number(process.env.CLAWMOBILE_COMPANION_PORT)||8765,
   path:'/v1/runs/'+encodeURIComponent(runId)+'/measurement',method:'POST',headers:{'Content-Type':'application/json',
    'Content-Length':Buffer.byteLength(encoded),'X-Clawmobile-Owner-Flow':'v1'}},res=>{
   let bytes=0,raw='';res.on('data',part=>{bytes+=part.length;if(bytes>4096){req.destroy(Error('measurement_response_too_large'));return;}raw+=part;});
   res.on('end',()=>{try{const value=JSON.parse(raw);if((res.statusCode||500)>=400)reject(Error('measurement_unavailable'));else resolve(value);}catch{reject(Error('measurement_invalid_response'));}});
  });req.setTimeout(1500,()=>req.destroy(Error('measurement_timeout')));req.on('error',reject);req.end(encoded);
 }).finally(()=>{observationPosts--;});
}
function nativePeer(ctx:Context,owners:()=>Set<string>){
 // AgentContext.channelId is the target/chat ID, while MessageContext.channelId is the channel.
 if((ctx.channel||ctx.messageProvider||ctx.channelId)!=='whatsapp'||ctx.agentId&&ctx.agentId!=='main')return false;
 const match=SESSION.exec(ctx.sessionKey||'');return !!match&&owners().has(match[1].startsWith('+')?match[1]:'+'+match[1]);
}
/** L3 provenance only. L4 will add its measurements and delivery handling to this same owner. */
export function nativeTurnProgressHooks(deps:{owners?:()=>Set<string>;post?:(id:string,body:any)=>Promise<any>;enabled?:()=>boolean}={}){
 const owners=deps.owners||ownerWhatsAppNumbers,post=deps.post||postObservation,enabled=deps.enabled||(()=>process.env.SAMANTHA_BRAIN_ONLY==='1');
 const valid=(event:any,ctx:Context)=>enabled()&&nativePeer(ctx,owners)&&RUN.test(ctx.runId||event?.runId||'')&&
  !(ctx.runId&&event?.runId&&ctx.runId!==event.runId)&&!(event?.sessionKey&&event.sessionKey!==ctx.sessionKey);
 return {
  async received(event:any,ctx:Context){if(!valid(event,ctx))return;
   await post(ctx.runId||event.runId,{operation:'native_ingress',sessionKey:ctx.sessionKey,accountId:ctx.accountId,
    observedMonoMs:Number(process.hrtime.bigint()/1000000n)}).catch(()=>{});
  },
  /** Public native user-persistence event; WA's optional received hook is not an identity source. */
  async transcript(event:any){
   const target=event?.target,sessionKey=target?.sessionKey,message=event?.message,meta=message?.__openclaw;
   const ingress=meta?.transport?.ingressRunId,adoptedBy=meta?.steerTargetRunId,started=meta?.transport?.ingressObservedMonoMs;
   const now=Number(process.hrtime.bigint()/1000000n);
   if(!enabled()||target?.agentId!=='main'||event?.agentId&&event.agentId!=='main'||
     event?.sessionKey&&event.sessionKey!==sessionKey||!nativePeer({channel:'whatsapp',agentId:'main',sessionKey},owners)||
     message?.role!=='user'||meta?.senderIsOwner!==true||meta?.transport?.channel!=='whatsapp'||
     message?.provenance&&message.provenance.kind!=='external_user'||!RUN.test(ingress||'')||
     !Number.isSafeInteger(started)||started<0||started>now||now-started>600000||
     adoptedBy!==undefined&&(!RUN.test(adoptedBy)||ingress===adoptedBy)||
     event?.messageSeq!==undefined&&(!Number.isSafeInteger(event.messageSeq)||event.messageSeq<1)||typeof event?.messageId!=='string'||!event.messageId)return;
   // Original dispatch clock, not callback time. No text and no owner permission are transported.
   await post(ingress,{operation:'native_ingress',sessionKey,observedMonoMs:started}).catch(()=>{});
   if(adoptedBy!==undefined)await post(ingress,{operation:'native_adoption',sessionKey,targetRunId:adoptedBy,
     observedMonoMs:now}).catch(()=>{});
  },
  async ended(event:any,ctx:Context){if(!valid(event,ctx)||typeof event?.success!=="boolean")return;
   await post(ctx.runId||event.runId,{operation:'native_end',sessionKey:ctx.sessionKey,success:event.success}).catch(()=>{});
  },
 };
}
export type NativeObservedRun={runId:string;sessionKey:string;clockEpoch:string;deadlineAt:number;state:"running";observationSource:"companion_native_turn_owner"};
/** Read-only adapter to the same owner. Not an abort authority or a candidate-selection heuristic. */
export async function activeObservedNativeWhatsAppRun(sessionKey:string,options:{excludeRunId?:string}={}):Promise<NativeObservedRun|null>{
 const id=options.excludeRunId||'native-observation';if(options.excludeRunId!==undefined&&!RUN.test(options.excludeRunId)||!SESSION.test(sessionKey))return null;
 try{
  const response=await postObservation(id,{operation:'native_active',sessionKey,excludeRunId:options.excludeRunId}),v=response?.active;
  if(!v||typeof v.runId!=='string'||!RUN.test(v.runId)||v.sessionKey!==sessionKey||v.state!=='running'||
    typeof v.clockEpoch!=='string'||!Number.isFinite(v.deadlineAt)||v.observationSource!=='companion_native_turn_owner')return null;
  return {runId:v.runId,sessionKey:v.sessionKey,clockEpoch:v.clockEpoch,deadlineAt:v.deadlineAt,state:'running',observationSource:'companion_native_turn_owner'};
 }catch{return null;}
}
