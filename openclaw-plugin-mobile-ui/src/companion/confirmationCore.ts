import {randomBytes,randomUUID,KeyObject} from "crypto";
import {OwnerIntent,OwnerProof,ownerUuid,ownerHex,ownerHash,ownerError,exactObject,validateOwnerIntent,ownerBinding,ownerMessage,verifyOwnerProof} from "./ownerConfirmationProtocol";
export type ConfirmationDraft={requestKey:string;action:OwnerIntent["action"];presentation:OwnerIntent["presentation"];origin:OwnerIntent["origin"]};
export type ConfirmationRecord={
 version:1;id:string;requestKey:string;intent:OwnerIntent;bindingHash:string;fingerprint:string;
 nonce:string;keyId:string;createdAt:number;expiresAt:number;
 state:"awaiting_owner"|"approved"|"cancelled"|"expired"|"consumed";
 decidedAt?:number;consumedAt?:number;proof?:OwnerProof;
};
export interface ConfirmationStore {
 read():Promise<ConfirmationRecord[]>;
 change<T>(operation:(rows:ConfirmationRecord[])=>T):Promise<T>;
}
function draft(value:any) {
 exactObject(value,["requestKey","action","presentation","origin"]);
 if(typeof value.requestKey!=="string"||!ownerUuid.test(value.requestKey))ownerError("invalid_confirmation_request");
 const intent=validateOwnerIntent({audience:"confirmation",action:value.action,presentation:value.presentation,origin:value.origin});
 return {requestKey:value.requestKey,intent,fingerprint:ownerHash(value.requestKey+"\n"+ownerBinding(intent))};
}
export function createConfirmationCore(options:{store:ConfirmationStore;key:()=>{key:KeyObject;id:string};clock?:()=>number}) {
 const now=options.clock||Date.now;
 function normalize(r:ConfirmationRecord) {
  if(!r||r.version!==1||typeof r.id!=="string"||!ownerUuid.test(r.id)||!ownerUuid.test(r.requestKey)||
   !["awaiting_owner","approved","cancelled","expired","consumed"].includes(r.state)||
   ![r.bindingHash,r.fingerprint,r.nonce,r.keyId].every(x=>typeof x==="string"&&ownerHex.test(x))||
   !Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.expiresAt)||r.expiresAt-r.createdAt!==120000||
   ownerBinding(r.intent)!==r.bindingHash||ownerHash(r.requestKey+"\n"+r.bindingHash)!==r.fingerprint)ownerError("confirmation_record_invalid",503);
  if(r.state==="approved"||r.state==="consumed") {
   if(!Number.isSafeInteger(r.decidedAt)||r.decidedAt! < r.createdAt||r.decidedAt! >= r.expiresAt)ownerError("confirmation_record_invalid",503);
   verifyOwnerProof(r,r.proof,options.key());
  }
  if((r.state==="awaiting_owner"||r.state==="approved")&&(now()>=r.expiresAt||now()<r.createdAt))r.state="expired";
  return r;
 }
 function locate(rows:ConfirmationRecord[],id:string) {
  if(typeof id!=="string"||!ownerUuid.test(id))ownerError("invalid_confirmation_request");
  const r=rows.find(x=>x.id===id);if(!r)ownerError("confirmation_not_found",404);
  return normalize(r);
 }
 function view(r:ConfirmationRecord) {
  return {schemaVersion:1,requestId:r.id,intent:r.intent,bindingHash:r.bindingHash,state:r.state,
   approved:r.state==="approved",ownerConfirmed:r.proof!==undefined,expiresAt:r.expiresAt,actionExecuted:false,
   metrics:{ownerWaitMs:r.decidedAt===undefined?null:Math.max(0,r.decidedAt-r.createdAt),
   totalMs:r.consumedAt===undefined?null:Math.max(0,r.consumedAt-r.createdAt)}};
 }
 return {
  capabilities:()=>({schemaVersion:1,capability:"owner.confirmation",ttlMs:120000,executesActions:false,
   signed:true,singleUse:true,consumeTransport:"trusted_in_process_only",nativeConfirmation:"experimental"}),
  async prepare(value:any) {
   const d=draft(value),key=options.key();
   return options.store.change(rows=>{
    const old=rows.find(x=>x.requestKey===d.requestKey);
    if(old) {normalize(old);if(old.fingerprint!==d.fingerprint)ownerError("confirmation_request_key_conflict",409);return view(old);}
    if(rows.length>=1000)ownerError("confirmation_registry_capacity_reached",409);
    const createdAt=now();
    const r:ConfirmationRecord={version:1,id:randomUUID(),requestKey:d.requestKey,intent:d.intent,bindingHash:ownerBinding(d.intent),
     fingerprint:d.fingerprint,nonce:randomBytes(32).toString("hex"),keyId:key.id,createdAt,expiresAt:createdAt+120000,state:"awaiting_owner"};
    rows.push(r);return view(r);
   });
  },
  async status(id:string) {return options.store.change(rows=>view(locate(rows,id)));},
  async challenge(id:string) {
   return options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="awaiting_owner")ownerError("confirmation_not_pending",409);
    if(options.key().id!==r.keyId)ownerError("owner_key_changed",409);
    return {...view(r),nonce:r.nonce,keyId:r.keyId,challenge:ownerMessage(r)};
   });
  },
  async cancel(id:string) {
   return options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state==="awaiting_owner"){r.state="cancelled";r.decidedAt=now();}
    return view(r);
   });
  },
  async confirm(id:string,proof:any) {
   return options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="awaiting_owner")ownerError("confirmation_already_decided",409);
    verifyOwnerProof(r,proof,options.key());
    r.state="approved";r.decidedAt=now();r.proof={...proof};return view(r);
   });
  },
  // No HTTP/CLI consume, callback URL or arbitrary executor. An integrated trusted
  // consumer checks the exact intent and claims it durably before its own action.
  async consume(id:string,expected:OwnerIntent) {
   const expectedHash=ownerBinding(expected);
   return options.store.change(rows=>{
    const r=locate(rows,id);
    if(r.state!=="approved")ownerError("confirmation_not_usable",409);
    if(r.bindingHash!==expectedHash)ownerError("confirmation_scope_mismatch",403);
    verifyOwnerProof(r,r.proof,options.key());
    r.state="consumed";r.consumedAt=now();
    return {schemaVersion:1,requestId:r.id,bindingHash:r.bindingHash,consumed:true,actionExecuted:false};
   });
  }
 };
}
