import {execFile} from "child_process";
import os from "os";
import {controlPaths} from "./control";

/** Read checkpoint metadata; never call task reconciliation or checkpoint repair. */
export function engineeringRead(offset:number,limit:number,revision?:string):Promise<any>{
  const args=["-m","reporting.control_engineering","--home",process.env.SAMANTHA_CONTROL_HOME||os.homedir(),"--offset",String(offset),"--limit",String(limit)];
  if(revision)args.push("--revision",revision);
  return new Promise((resolve,reject)=>execFile("python3",args,{cwd:controlPaths().playbooks,timeout:3500,maxBuffer:131072},(error,stdout)=>{
    if(error){reject(new Error("engineering_unavailable"));return;}
    try{
      const value=JSON.parse(stdout);
      if(value.receipt!==null||!['ok','partial','conflict'].includes(value.state)||(!Array.isArray(value.items)&&value.state!=='conflict'))throw Error();
      resolve(value);
    }catch{reject(new Error("engineering_unavailable"));}
  }));
}
