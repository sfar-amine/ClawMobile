import {execFile} from "child_process";
import os from "os";
import {controlPaths} from "./control";
const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export async function notificationSources():Promise<any>{
 return new Promise((resolve,reject)=>execFile('python3',['-m','reporting.control_notifications','--home',process.env.SAMANTHA_CONTROL_HOME||os.homedir()],{cwd:controlPaths().playbooks,timeout:8500,maxBuffer:262144},(error,stdout)=>{
  if(error){reject(nativeError('notification_sources_unavailable',503));return;}
  try{const value=JSON.parse(stdout);if(!Array.isArray(value.sources)||value.sources.length>256)throw Error();resolve(value);}catch{reject(nativeError('notification_sources_unavailable',503));}
 }));
}
