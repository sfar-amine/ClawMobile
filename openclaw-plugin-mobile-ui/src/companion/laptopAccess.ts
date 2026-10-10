import {spawn} from 'child_process';
import {controlPaths} from './control';
import path from 'path';
import {confirmations} from './confirmations';
import {nativeOperation,nativeError,operationBody} from './nativeOperation';
import {ownerUuid,type OwnerIntent} from './ownerConfirmationProtocol';
const pairing=/^[a-f0-9]{32}$/;
const fingerprint=/^SHA256:[A-Za-z0-9+/]{43}$/;
export async function laptopOwner(action:string,body:any={}):Promise<any>{
 return new Promise((resolve,reject)=>{
  const child=spawn('python3',[path.join(controlPaths().playbooks,'device/laptop_access.py'),action],{stdio:['pipe','pipe','pipe']});let text='';let size=0;let settled=false;
  const timeout=['pair-start','pair-commit','revoke'].includes(action)?20000:3500;
  const timer=setTimeout(()=>{child.kill();done(nativeError('laptop_owner_indeterminate',503));},timeout);
  function done(error?:any,value?:any){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
  child.stderr.resume();child.on('error',()=>done(nativeError('laptop_owner_unavailable',503)));
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>65536){child.kill();done(nativeError('laptop_owner_unavailable',503));}else text+=chunk;});
  child.on('close',code=>{try{if(code!==0)throw Error();const value=JSON.parse(text);if(typeof value.success!=='boolean'||typeof value.state!=='string')throw Error();done(undefined,value);}catch{done(nativeError('laptop_owner_indeterminate',503));}});
  child.stdin.on('error',()=>done(nativeError('laptop_owner_indeterminate',503)));child.stdin.end(JSON.stringify(body));
 });
}
export async function laptopList(){return laptopOwner('list');}
export async function laptopPairStart(body:any){return laptopOwner('pair-start',{operationId:operationBody(body)});}
export async function laptopPairStatus(id:string){if(!pairing.test(id))throw nativeError('invalid_pairing');return laptopOwner('pair-status',{pairingId:id});}
export async function laptopChange(kind:'commit'|'revoke',id:string,body:any){
 if(!(kind==='commit'?pairing:fingerprint).test(id)||!body||Object.keys(body).sort().join(',')!=='confirmationId,operationId'||!ownerUuid.test(body.confirmationId||''))throw nativeError('invalid_laptop_operation');
 const operationId=operationBody({operationId:body.operationId});
 const action=kind==='commit'?'laptop_access.authorize_key':'laptop_access.revoke_key';
 const result=await nativeOperation(operationId,action,id,async()=>{
  let payloadHash:string;
  if(kind==='commit'){
   const pair=await laptopPairStatus(id);
   if(pair.state!=='awaiting_owner')return {state:'refused',artifact:{reason:'pairing_not_ready'}};
   payloadHash=pair.payloadHash;
  }else{
   const listed=await laptopList();const item=listed.computers?.find((x:any)=>x.id===id);
   if(!item)return {state:'refused',artifact:{reason:'unknown_computer'}};
   if(listed.computers.length<2)return {state:'refused',artifact:{reason:'last_key'}};
   payloadHash=item.payloadHash;
  }
  if(!/^[a-f0-9]{64}$/.test(payloadHash))throw nativeError('laptop_owner_unavailable',503);
  try{
   const confirmation=await confirmations.status(body.confirmationId);
   const expected:OwnerIntent={audience:'confirmation',action:{type:action,reference:id,payloadHash},presentation:confirmation.intent.presentation,origin:confirmation.intent.origin};
   // Core verifies the exact binding and biometric proof, then claims single use durably.
   await confirmations.consume(body.confirmationId,expected);
  }catch(error:any){
   if([400,403,404,409].includes(error.statusCode))return {state:'refused',artifact:{reason:'confirmation_not_usable'}};
   throw error;
  }
  const canonical=await laptopOwner(kind==='commit'?'pair-commit':'revoke',{operationId,confirmationId:body.confirmationId,...(kind==='commit'?{pairingId:id}:{id})});
  if(canonical.state==='indeterminate')throw nativeError('laptop_owner_indeterminate',503);
  if(!canonical.success)return {state:'refused',artifact:{reason:canonical.reason||'laptop_action_refused'}};
  return {state:'completed',artifact:{canonical}};
 });
 const canonical=(result as any).artifact?.canonical;
 return canonical?{...result,state:canonical.state,canonicalReceipt:canonical.receipt}:result;
}
