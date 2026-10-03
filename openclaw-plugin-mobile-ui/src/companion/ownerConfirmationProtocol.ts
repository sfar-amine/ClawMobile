import {createHash,createPublicKey,KeyObject,verify} from "crypto";
export type OwnerOrigin={channel:"chatgpt"|"work"|"claw"|"samantha";id:string};
export type OwnerIntent={
 audience:"confirmation";
 action:{type:string;reference:string;payloadHash:string};
 presentation:{title:string;subtitle:string;description:string};
 origin:OwnerOrigin;
};
export type OwnerProof={keyId:string;nonce:string;bindingHash:string;signature:string};
export const ownerUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const ownerHex=/^[a-f0-9]{64}$/;
export const ownerHash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
export function ownerError(code:string,statusCode=400):never {throw Object.assign(new Error(code),{statusCode});}
export function exactObject(v:any,keys:string[]) {
 if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(v,k)))ownerError("invalid_confirmation_request");
}
export function ownerText(v:any,max:number) {return typeof v==="string"&&v.length>0&&v.length<=max&&v===v.trim()&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(v);}
export function validateOwnerIntent(v:any):OwnerIntent {
 exactObject(v,["audience","action","presentation","origin"]);
 exactObject(v.action,["type","reference","payloadHash"]);
 exactObject(v.presentation,["title","subtitle","description"]);
 exactObject(v.origin,["channel","id"]);
 if(v.audience!=="confirmation"||typeof v.action.type!=="string"||!/^[a-z][a-z0-9_.-]{1,60}$/.test(v.action.type)||
 !ownerText(v.action.reference,100)||typeof v.action.payloadHash!=="string"||!ownerHex.test(v.action.payloadHash)||
 !ownerText(v.presentation.title,64)||!ownerText(v.presentation.subtitle,96)||!ownerText(v.presentation.description,320)||
 !["chatgpt","work","claw","samantha"].includes(v.origin.channel)||!ownerText(v.origin.id,120))ownerError("invalid_confirmation_request");
 return {audience:"confirmation",action:{type:v.action.type,reference:v.action.reference,payloadHash:v.action.payloadHash},
 presentation:{title:v.presentation.title,subtitle:v.presentation.subtitle,description:v.presentation.description},
 origin:{channel:v.origin.channel,id:v.origin.id}};
}
export function ownerBinding(v:OwnerIntent) {
 const i=validateOwnerIntent(v);
 return ownerHash(["claw.owner.intent.v1",i.audience,i.action.type,i.action.reference,i.action.payloadHash,
 i.presentation.title,i.presentation.subtitle,i.presentation.description,i.origin.channel,i.origin.id].join("\n"));
}
export function ownerMessage(r:{id:string;nonce:string;bindingHash:string;expiresAt:number;keyId:string}) {
 return ["claw.owner.confirmation.v1",r.id,r.nonce,r.bindingHash,r.expiresAt,r.keyId].join("\n");
}
export function ownerKey(value:string|Buffer):{key:KeyObject;id:string} {
 const key=createPublicKey(value);
 if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")ownerError("invalid_owner_key",503);
 return {key,id:ownerHash(key.export({type:"spki",format:"der"}) as Buffer)};
}
export function verifyOwnerProof(r:{id:string;nonce:string;bindingHash:string;expiresAt:number;keyId:string},proof:any,key:{key:KeyObject;id:string}) {
 exactObject(proof,["keyId","nonce","bindingHash","signature"]);
 if(![proof.keyId,proof.nonce,proof.bindingHash].every(x=>typeof x==="string"&&ownerHex.test(x))||
 typeof proof.signature!=="string"||!/^[A-Za-z0-9+/]{80,120}={0,2}$/.test(proof.signature)||
 key.id!==r.keyId||proof.keyId!==r.keyId||proof.nonce!==r.nonce||proof.bindingHash!==r.bindingHash||
 !verify("sha256",Buffer.from(ownerMessage(r),"utf8"),key.key,Buffer.from(proof.signature,"base64")))ownerError("invalid_owner_proof",403);
}
