import {execFile} from "child_process";
import path from "path";
import os from "os";
import fs from "fs/promises";
import {readFileSync} from "fs";
import {latestCompanionDeploymentAt} from "./deploymentReceipts";
import {withCompanionDeploymentDate} from "./updateDeploymentDate";

/**
 * Deployed commit of this Companion, read once at start from the checkout it
 * runs from (companion-deploy.sh fast-forwards then restarts, rollback resets
 * then restarts). Plain file reads, no git process; absent -> package version only.
 */
function headCommit(repo:string):string|null{
 try{
  let gitDir=path.join(repo,".git");
  try{const pointer=readFileSync(gitDir,"utf8").trim();if(pointer.startsWith("gitdir:"))gitDir=path.resolve(repo,pointer.slice(7).trim());}catch{/* .git is a directory */}
  const head=readFileSync(path.join(gitDir,"HEAD"),"utf8").trim();
  if(/^[0-9a-f]{40}$/.test(head))return head;
  const ref=/^ref: (refs\/[A-Za-z0-9._\/-]{1,200})$/.exec(head)?.[1];
  if(!ref||ref.includes(".."))return null;
  const common=(()=>{try{return path.resolve(gitDir,readFileSync(path.join(gitDir,"commondir"),"utf8").trim());}catch{return gitDir;}})();
  for(const dir of [gitDir,common]){try{const value=readFileSync(path.join(dir,ref),"utf8").trim();if(/^[0-9a-f]{40}$/.test(value))return value;}catch{}}
  const packed=readFileSync(path.join(common,"packed-refs"),"utf8").split("\n").find(line=>line.endsWith(" "+ref));
  return packed&&/^[0-9a-f]{40} /.test(packed)?packed.slice(0,40):null;
 }catch{return null;}
}
const packageVersion:string=require("../../package.json").version;
const deployedCommit=headCommit(path.resolve(__dirname,"../../.."));
/** `0.1.0+9cdd84f` (SemVer build metadata) when the deployed commit is known. */
export function companionBuildVersion():string{return deployedCommit?packageVersion+"+"+deployedCommit.slice(0,7):packageVersion;}
let cache:{key:string;until:number;value:any}|undefined;
let flight:{key:string;promise:Promise<any>}|undefined;
async function fingerprint(home:string){
 const root=path.join(home,".openclaw"),sources=["releases","releases/current","releases/last-known-good","tier0/state.json","runtime-ui-playbooks/current"];
 return JSON.stringify(await Promise.all(sources.map(async source=>{const file=path.join(root,source);try{const info=await fs.lstat(file);return [source,info.ino,info.mtimeMs,info.ctimeMs,info.size,...(info.isSymbolicLink()?[await fs.readlink(file)]:[])];}catch{return [source,null];}})));
}

async function generate():Promise<any>{
 const helper=process.env.SAMANTHA_TIER0_NATIVE||path.join(os.homedir(),"ClawMobile/installer/termux-lite/tier0-native-read.py");
 const args=[helper,"--home",process.env.SAMANTHA_CONTROL_HOME||os.homedir(),"--companion-version",companionBuildVersion()];
 return new Promise((resolve,reject)=>execFile("python3",args,{timeout:3500,maxBuffer:65536},(error,stdout)=>{
  if(error){reject(new Error("updates_unavailable"));return;}
  try{const value=JSON.parse(stdout);if(value.success!==true||!Array.isArray(value.items)||value.items.length!==4||value.receipt!==null||value.actions?.length)throw Error();withCompanionDeploymentDate(value,deployedCommit,latestCompanionDeploymentAt).then(resolve,()=>reject(new Error("updates_unavailable")));}catch{reject(new Error("updates_unavailable"));}
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
