import {conversationArchiveState,setConversationArchived,readPaymentRequests,readOwnerConfirmations} from './runs';
import type {RunReservationAdmission} from './runs';
import {nativeError,operationBody,existingNativeOperation,nativeOperation} from './nativeOperation';
const pending=new Map<string,Promise<any>>();
/** Reversible presentation setting using the existing archive and native receipt owners. */
export async function changeConversationArchive(id:string,archived:boolean,body:any):Promise<any>{
  if(typeof id!=='string'||!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)||id.length>80)throw nativeError('invalid_session_id');
  const operationId=operationBody(body);
  if(pending.has(operationId)){await pending.get(operationId);return changeConversationArchive(id,archived,body);}
  if(pending.size>=64)throw nativeError('conversation_archive_busy',429);
  const work=changeOnce(id,archived,operationId);pending.set(operationId,work);
  try{return await work;}finally{if(pending.get(operationId)===work)pending.delete(operationId);}
}
async function changeOnce(id:string,archived:boolean,operationId:string){
  const action=archived?'conversation.archive':'conversation.unarchive',target=id;
  const identity=JSON.stringify({action,target});
  const existing=await existingNativeOperation(operationId,identity);if(existing)return archiveResponse(existing);
  const before=await conversationArchiveState(id);if(before===null)throw nativeError('conversation_not_found',404);
  const [payments,confirmations]=await Promise.all([readPaymentRequests(),readOwnerConfirmations()]);
  if(id==='native-owner-actions'||payments.some(row=>['awaiting_owner','executing','effect_unknown','requires_bank_action'].includes(row.state))||
    confirmations.some(row=>row.state==='awaiting_owner'&&row.expiresAt>Date.now()))throw nativeError('protected_owner_activity',409);
  return archiveResponse(await nativeOperation(operationId,action,target,async()=>({state:'completed',artifact:await setConversationArchived(id,archived)}),archiveAdmission(operationId,action,target,archived)));

}

function archiveResponse(value:any){return value.state==='blocked'?{...value,httpStatus:409}:value;}

/** E4 alone refuses before a receipt would evict retained history. No retention policy change. */
function archiveAdmission(operationId:string,action:string,target:string,archived:boolean):RunReservationAdmission{
 return (run,existing,canRetain)=>{
  const result={artifact:{sessionId:target,archived,changed:false},success:true,state:'completed',receipt:{version:1,action,target,operationId,runId:run.runId,state:'completed',at:Date.now()}};
  const completed={...run,state:'done' as const,result:JSON.stringify(result)};
  // Concurrent E4 reservations must include room for their final receipts, before settlement.
  const rows=existing.map(row=>row.state==='running'&&['conversation.archive','conversation.unarchive'].includes(String(row.decision?.capability))?{...row,result:(row.result||'')+' '.repeat(2048)}:row);
  if(!canRetain([completed,...rows]))throw nativeError('archive_capacity_exceeded',503);
 };
}
