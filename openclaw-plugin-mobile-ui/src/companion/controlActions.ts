import {execFile} from "child_process";
import os from "os";
import {controlPaths} from "./control";
import {operationBody,nativeError,storedNativeOperationResult} from "./nativeOperation";
import {reserveSubmittedRun,settleSubmittedRun} from "./runs";

type Outcome={success:boolean;state:string;receipt:any;reason?:string};
function callOwner(reference:string,operationId:string,checkOnly:boolean):Promise<Outcome>{
 const roots=controlPaths();
 const args=["-m","reporting.control_actions","--home",process.env.SAMANTHA_CONTROL_HOME||os.homedir(),
  "cancel-request","--reference",reference,"--operation-id",operationId,...(checkOnly?["--check-only"]:[])];
 return new Promise((resolve,reject)=>execFile("python3",args,{cwd:roots.playbooks,timeout:10000,maxBuffer:65536},(error,stdout)=>{
  if(error){reject(nativeError("control_action_unavailable",503));return;}
  try{
   const value=JSON.parse(stdout);
   if(!["ready","cancelled","already_closed","not_found","refused","indeterminate"].includes(value.state)||typeof value.success!=="boolean")throw Error();
   const raw=value.receipt;
   const receipt=raw&&raw.action==="cancel_request"&&raw.reference===reference&&raw.operationId===operationId&&/^[a-f0-9]{64}$/.test(raw.eventId||"")?
    {version:1,action:"cancel_request",operationId,reference,eventId:raw.eventId,intentId:raw.intentId,state:"cancelled",at:raw.at}:null;
   if(value.state==="cancelled"&&!receipt)throw Error();
   const result:Outcome={success:value.success,state:value.state,receipt};
   if(["cancel_unavailable_for_payment","request_source_unavailable","canonical_projection_pending","canonical_receipt_unavailable","request_writer_unavailable"].includes(value.reason))result.reason=value.reason;
   resolve(result);
  }catch{reject(nativeError("control_action_unavailable",503));}
 }));
}
export async function cancelControlRequest(reference:string,body:any):Promise<Outcome>{
 if(!/^REQ-[1-9][0-9]{0,15}$/.test(reference))throw nativeError("invalid_request_reference");
 const operationId=operationBody(body);
 // Preflight includes canonical receipt lookup and payment/ownership refusal.
 // A refused banking request produces no reservation or writer invocation.
 const observed=await callOwner(reference,operationId,true);
 if(observed.state!=="ready")return observed;
 const identity=JSON.stringify({action:"cancel_request",reference});
 const reservation=await reserveSubmittedRun(identity,"native-owner-actions","request-cancel-"+operationId+"-"+reference,
  {requestText:identity,executionSource:"capability_first",decision:{version:2,type:"EXECUTE",capability:"request.cancel"}});
 if(!reservation.created)return await storedNativeOperationResult(reservation.status.runId).catch(()=>null)||{success:false,state:"indeterminate",receipt:null};
 let result:Outcome;
 try{result=await callOwner(reference,operationId,false);}
 catch{
  // One read can establish an effect committed before a process timeout.
  try{const checked=await callOwner(reference,operationId,true);result=checked.state==="ready"?{success:false,state:"indeterminate",receipt:null}:checked;}
  catch{result={success:false,state:"indeterminate",receipt:null};}
 }
 await settleSubmittedRun(reservation.status.runId,"done",JSON.stringify(result));
 return await storedNativeOperationResult(reservation.status.runId).catch(()=>null)||{success:false,state:"indeterminate",receipt:null};
}
