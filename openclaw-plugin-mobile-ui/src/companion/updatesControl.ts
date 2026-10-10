import {execFile} from "child_process";
import path from "path";
import os from "os";
import fs from "fs/promises";
let cache:{key:string;until:number;value:any}|undefined;
let flight:{key:string;promise:Promise<any>}|undefined;
async function fingerprint(home:string){
 const root=path.join(home,".openclaw"),sources=["releases","releases/current","releases/last-known-good","tier0/state.json","runtime-ui-playbooks/current"];
 return JSON.stringify(await Promise.all(sources.map(async source=>{const file=path.join(root,source);try{const info=await fs.lstat(file);return [source,info.ino,info.mtimeMs,info.ctimeMs,info.size,...(info.isSymbolicLink()?[await fs.readlink(file)]:[])];}catch{return [source,null];}})));
}

async function generate():Promise<any>{
 const helper=process.env.SAMANTHA_TIER0_NATIVE||path.join(os.homedir(),"ClawMobile/installer/termux-lite/tier0-native-read.py");
 const args=[helper,"--home",process.env.SAMANTHA_CONTROL_HOME||os.homedir(),"--companion-version",require("../../package.json").version];
 return new Promise((resolve,reject)=>execFile("python3",args,{timeout:3500,maxBuffer:65536},(error,stdout)=>{
  if(error){reject(new Error("updates_unavailable"));return;}
  try{const value=JSON.parse(stdout);if(value.success!==true||!Array.isArray(value.items)||value.items.length!==4||value.receipt!==null||value.actions?.length)throw Error();resolve(value);}catch{reject(new Error("updates_unavailable"));}
 }));
}

export async function updatesRead():Promise<any>{
 const home=process.env.SAMANTHA_CONTROL_HOME||os.homedir(),key=JSON.stringify([home,process.env.SAMANTHA_TIER0_NATIVE||null,await fingerprint(home)]);
 if(cache&&cache.key===key&&cache.until>Date.now())return structuredClone(cache.value);
 if(flight&&flight.key===key)return structuredClone(await flight.promise);
 const promise=generate().then(value=>{cache={key,until:Date.now()+1000,value};return value;});
 const owned={key,promise};flight=owned;
 try{return structuredClone(await promise);}finally{if(flight===owned)flight=undefined;}
}
