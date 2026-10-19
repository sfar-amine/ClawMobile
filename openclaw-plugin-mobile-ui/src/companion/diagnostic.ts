import {receiptPresentationCounters} from "./receiptPresentation";
import {execFile} from "child_process";
import os from "os";
import crypto from "crypto";
import {controlPaths} from "./control";
const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});

export function diagnosticRead(command:"logs"|"export",source?:string,parameters=new URLSearchParams()):Promise<any>{
 const roots=controlPaths();
 const args=["-m","reporting.control_diagnostic","--home",process.env.SAMANTHA_CONTROL_HOME||os.homedir(),command];
 if(command==="export")args.push("--companion-version",require("../../package.json").version);
 if(command==="logs"){
  if(!["agent","installation","engineering"].includes(source||""))throw nativeError("invalid_log_source");
  for(const [key] of parameters)if(!["offset","limit","revision"].includes(key)||parameters.getAll(key).length!==1)throw nativeError("invalid_log_query");
  for(const key of ["offset","limit"])if(parameters.has(key)&&!/^\d{1,4}$/.test(parameters.get(key)!))throw nativeError("invalid_log_query");
  if(parameters.has("revision")&&!/^[a-f0-9]{64}$/.test(parameters.get("revision")!))throw nativeError("invalid_log_query");
  args.push("--source",source!);for(const [key,value]of parameters)args.push("--"+key,value);
 }
 return new Promise((resolve,reject)=>execFile("python3",args,{cwd:roots.playbooks,timeout:5000,maxBuffer:262144},(error,stdout)=>{
  if(error){reject(nativeError("diagnostic_source_unavailable",503));return;}
  try{const value=JSON.parse(stdout);
   if(command==="export"){
    const data=typeof value.data==="string"?Buffer.from(value.data,"base64"):Buffer.alloc(0);
    if(value.mime!=="application/zip"||value.name!=="samantha-diagnostic.zip"||value.metadataOnly!==true||data.length!==value.bytes||data.length>131072||crypto.createHash("sha256").update(data).digest("hex")!==value.sha256)throw Error();
   }else if(!Array.isArray(value.items)||value.items.length>100||typeof value.available!=="boolean")throw Error();
   resolve({...value,presentationCounters:receiptPresentationCounters()});
  }catch{reject(nativeError("diagnostic_source_unavailable",503));}
 }));
}
