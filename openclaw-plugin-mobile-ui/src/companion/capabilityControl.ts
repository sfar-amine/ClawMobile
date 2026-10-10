import {execFile} from "child_process";
import {controlPaths} from "./control";
import {nativeError} from "./nativeOperation";
export async function capabilityDetail(id:string):Promise<any>{
 if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(id))throw nativeError("invalid_capability_id");
 return new Promise((resolve,reject)=>execFile("python3",["-m","reporting.control_capability","--id",id],{cwd:controlPaths().playbooks,timeout:2000,maxBuffer:65536},(error,stdout)=>{
  if(error){reject(nativeError("capability_registry_unavailable",503));return;}
  try{const value=JSON.parse(stdout);if(!value||typeof value.found!=="boolean"||(!value.found&&value.item!==null)||value.found&&(value.schemaVersion!==1||!/^([a-f0-9]{64})$/.test(value.revision||"")||value.item?.id!==id||value.item?.liveState!=="unknown"||!Array.isArray(value.item.routes)||value.item.routes.length>40||!Array.isArray(value.item.examples)||value.item.examples.length>10))throw Error();resolve(value);}catch{reject(nativeError("capability_registry_unavailable",503));}
 }));
}
