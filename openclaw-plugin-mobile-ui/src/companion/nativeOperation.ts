import fs from "fs/promises";
import {constants} from "fs";
import os from "os";
import path from "path";
import {reserveSubmittedRun,settleSubmittedRun,type RunReservationAdmission} from "./runs";

export const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export function operationBody(body:any):string{
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||
    typeof body.operationId!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId))throw nativeError("invalid_operation");
  return body.operationId;
}
async function readNativeRegistry(){
 const directory=path.join(process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),".openclaw"),"clawmobile-companion");
 const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw nativeError("receipt_unavailable",503);
 const file=await fs.open(path.join(directory,"runs.json"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw nativeError("receipt_unavailable",503);
  const content=await file.readFile();if(content.length>8*1024*1024)throw nativeError("receipt_unavailable",503);
  const registry=JSON.parse(content.toString("utf8"));
  return registry;
 }finally{await file.close();}
}
export async function existingNativeOperation(operationId:string,identity:string){
 let registry:any;try{registry=await readNativeRegistry();}catch(e:any){if(e.code==="ENOENT")return null;throw e;}
 const run=registry.runs?.find((r:any)=>r.clientRunId==="native-operation-"+operationId);
 if(!run)return null;
 if(run.text!==identity||run.sessionId!=="native-owner-actions")throw nativeError("operation_conflict",409);
 return await storedNativeOperationResult(run.runId)||{success:false,state:"indeterminate",receipt:null};
}
export async function storedNativeOperationResult(runId:string){
 const registry=await readNativeRegistry();
 const run=registry.runs?.find((row:any)=>row.runId===runId);
  if(run?.state!=="done"||typeof run.result!=="string")return null;
  const value=JSON.parse(run.result);
  return value?.receipt?.runId===runId&&value.receipt.version===1 ||
    value?.receipt?.action==="cancel_request"&&/^[a-f0-9]{64}$/.test(value.receipt.eventId||"") ||
    value?.receipt===null&&["refused","already_closed","not_found","indeterminate"].includes(value.state)?value:null;
}
/** Effects are claimed only after the existing canonical run ledger has persisted the receipt. */
export async function nativeOperation(operationId:string,action:string,target:string,effect:()=>Promise<"completed"|"accepted"|{state:"completed"|"accepted"|"refused";artifact:Record<string,unknown>}>,admission?:RunReservationAdmission){
 const identity=JSON.stringify({action,target});
 const reserved=await reserveSubmittedRun(identity,"native-owner-actions","native-operation-"+operationId,
  {requestText:identity,executionSource:"capability_first",decision:{version:2,type:"EXECUTE",capability:action},admission});
 const unknown={success:false,state:"indeterminate",receipt:null};
 if(!reserved.created)return await storedNativeOperationResult(reserved.status.runId).catch(()=>null)||unknown;
 let state:string;let artifact:Record<string,unknown>|undefined;
 try{const value=await effect();state=typeof value==="string"?value:value.state;if(typeof value!=="string")artifact=value.artifact;}catch(error:any){state=error?.effectNotStarted===true&&error?.statusCode===409?"blocked":"indeterminate";}
 const result={...(artifact?{artifact}:{}),success:state==="completed"||state==="accepted",state,receipt:{version:1,action,target,operationId,
   runId:reserved.status.runId,state,at:Date.now()}};
 await settleSubmittedRun(reserved.status.runId,"done",JSON.stringify(result));
 return await storedNativeOperationResult(reserved.status.runId).catch(()=>null)||unknown;
}
