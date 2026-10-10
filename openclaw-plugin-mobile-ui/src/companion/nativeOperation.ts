import fs from "fs/promises";
import {constants} from "fs";
import os from "os";
import path from "path";

export const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export function operationBody(body:any):string{
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||
    typeof body.operationId!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.operationId))throw nativeError("invalid_operation");
  return body.operationId;
}
export async function storedNativeOperationResult(runId:string){
 const directory=path.join(process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),".openclaw"),"clawmobile-companion");
 const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw nativeError("receipt_unavailable",503);
 const file=await fs.open(path.join(directory,"runs.json"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw nativeError("receipt_unavailable",503);
  const content=await file.readFile();if(content.length>8*1024*1024)throw nativeError("receipt_unavailable",503);
  const registry=JSON.parse(content.toString("utf8"));
  const run=registry.runs?.find((row:any)=>row.runId===runId);
  if(run?.state!=="done"||typeof run.result!=="string")return null;
  const value=JSON.parse(run.result);
  return value?.receipt?.runId===runId&&value.receipt.version===1 ||
    value?.receipt?.action==="cancel_request"&&/^[a-f0-9]{64}$/.test(value.receipt.eventId||"") ||
    value?.receipt===null&&["refused","already_closed","not_found","indeterminate"].includes(value.state)?value:null;
 }finally{await file.close();}
}
