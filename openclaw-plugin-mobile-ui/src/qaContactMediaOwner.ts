import path from "path";
import {performance} from "perf_hooks";
import {allowlistOwner,qaAttachmentOwner} from "./companion/whatsappAllowlist";
import {loadOfficialMediaStore} from "./companion/officialGatewayOwner";
import {receiveQaContactMedia,type QaMediaOwners} from "./qaContactMediaIngress";

type Dependencies={people:typeof allowlistOwner;attachment:typeof qaAttachmentOwner;media:typeof loadOfficialMediaStore};
const defaults:Dependencies={people:allowlistOwner,attachment:qaAttachmentOwner,media:loadOfficialMediaStore};
const plain=(value:any)=>value!==null&&typeof value==="object"&&!Array.isArray(value);

/** Per-hook wiring of existing owners. No retained state, model, sender or notification. */
export function qaContactMediaOwners(event:any,deps:Dependencies=defaults):QaMediaOwners {
 const messageId=event?.messageId;
 const facts=Array.isArray(event?.media)?event.media.slice(0,4).map((f:any)=>plain(f)?
  {path:f.path,messageId:f.messageId}:null):[];
 return {
  async admit(identity,control){
   const started=performance.now();
   const authority=await deps.people("qa-ingress-read",{requester_hash:identity.requester_hash},false,true,control);
   if(authority?.ok!==true||!Array.isArray(authority.grants)||!authority.grants.length||authority.grants.length>12)return null;
   const remaining_ms=Math.floor(control.remaining_ms-(performance.now()-started));
   if(control.signal.aborted||remaining_ms<1)return null;
   const context={schema_version:1,access_class:"qa_room",requester_hash:identity.requester_hash,
    thread_ref:identity.thread_ref,conversation_kind:"direct",transport_event_id:identity.transport_event_id,
    owner:false,grants:authority.grants};
   const result=await deps.attachment("admit",{context},{...control,remaining_ms});
   return result?.ok===true?result.admission:null;
  },
  async inboundRoot(_admission,control){
   if(control.signal.aborted||facts.length===0)throw Error("qa_media_root_unavailable");
   const sdk=await deps.media(process.env.CLAWMOBILE_OPENCLAW_BIN||"openclaw");
   let root:string|undefined;
   for(const fact of facts){
    if(control.signal.aborted||!fact||fact.messageId!==messageId||typeof fact.path!=="string"||
      fact.path.length>4096||!path.isAbsolute(fact.path)||/[\0\r\n]/.test(fact.path))throw Error("qa_media_root_unavailable");
    const id=path.basename(fact.path);
    if(!id||id==="."||id==="..")throw Error("qa_media_root_unavailable");
    // The installed SDK, not a requested root, resolves the fact's opaque inbound ID.
    const canonical=await sdk.resolveMediaBufferPath(id,"inbound");
    if(typeof canonical!=="string"||!path.isAbsolute(canonical)||canonical!==path.resolve(fact.path)||
      path.basename(canonical)!==id||/[\0\r\n]/.test(canonical))throw Error("qa_media_root_unavailable");
    const current=path.dirname(canonical);
    if(root!==undefined&&root!==current)throw Error("qa_media_root_unavailable");
    root=current;
   }
   return root!;
  },
  async consume(admission,metadata,content,control){
   const result=await deps.attachment("consume",{admission,metadata},{...control,content});
   return {state:["imported","blocked","unknown"].includes(result?.state)?result.state:"unknown"};
  }
 };
}
export async function handleQaContactMediaReceived(event:any,context:any,deps:Dependencies=defaults){
 return receiveQaContactMedia(event,context,qaContactMediaOwners(event,deps));
}
