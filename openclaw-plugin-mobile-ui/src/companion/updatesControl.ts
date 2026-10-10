import {execFile} from "child_process";
import path from "path";
import os from "os";
export function updatesRead():Promise<any>{
 const helper=process.env.SAMANTHA_TIER0_NATIVE||path.join(os.homedir(),"ClawMobile/installer/termux-lite/tier0-native-read.py");
 const args=[helper,"--home",process.env.SAMANTHA_CONTROL_HOME||os.homedir(),"--companion-version",require("../../package.json").version];
 return new Promise((resolve,reject)=>execFile("python3",args,{timeout:3500,maxBuffer:65536},(error,stdout)=>{
  if(error){reject(new Error("updates_unavailable"));return;}
  try{const value=JSON.parse(stdout);if(value.success!==true||!Array.isArray(value.items)||value.items.length!==4||value.receipt!==null||value.actions?.length)throw Error();resolve(value);}catch{reject(new Error("updates_unavailable"));}
 }));
}
