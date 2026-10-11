import {conditionalRead} from "./readEtag";
import {completeUsageAttention} from './usageControl';
import {allJobs,protectedJob} from "./automations";
import { execFile, spawn } from "child_process";
import {existsSync, constants} from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import os from "os";
import path from "path";
import readline from "readline";
import { randomUUID, createHash } from "crypto";
import { performance } from "perf_hooks";
import fs from "fs/promises";
import { completeHealthSection } from "./control-health";
import {companionBuildVersion} from "./updatesControl";

const sections = new Set(["snapshot", "activity", "requests", "missions", "automations", "intelligence", "health", "situations", "notifications", "diagnostic"]);
let activeStreams = 0;

export function controlPaths() {
  const pinned=path.join(os.homedir(), ".openclaw/runtime-ui-playbooks/current");
  return {
    playbooks: process.env.SAMANTHA_CONTROL_PLAYBOOKS || process.env.CLAW_UI_PLAYBOOKS_ROOT || (existsSync(path.join(pinned,"reporting/control_snapshot.py")) ? pinned : path.join(os.homedir(), ".openclaw/workspace/ui-playbooks")),
    live: process.env.SAMANTHA_CONTROL_LIVE || path.join(os.homedir(), "ClawMobile/installer/termux-lite/claw-live.py"),
  };
}

/** This module ships with the canonical automation owner routes installed by P2-a. */
export function automationNotificationProjection(value:any,jobs:any[]=[]):any {
  if(!value||!Array.isArray(value.items))return value;
  return {...value,activationRoute:'/v1/automations/{automationId}/enable|disable',items:value.items.map((item:any)=>
    item?.kind==='scheduled'&&typeof item.automationId==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(item.automationId)
      ? (()=>{const job=jobs.find(j=>j.id===item.automationId);return {...item,togglable:!!job&&!protectedJob(job),reason:job?(protectedJob(job)?'protected_automation':'delivery_evidence_unavailable'):'automation_unavailable'};})() : item)};
}

export function readControl(section: string, signal?: AbortSignal): Promise<unknown> {
  if (!sections.has(section)) return Promise.reject(new Error("unsupported_control_section"));
  const roots = controlPaths();
  return new Promise((resolve, reject) => {
    execFile("python3", ["-m", "reporting.control_snapshot", "--section", section], {
      cwd: roots.playbooks, env: { ...process.env, SAMANTHA_CONTROL_LIVE: roots.live },
      timeout: 6500, maxBuffer: 1024 * 1024, signal,
    }, async (error, stdout) => {
      if (error) return reject(new Error("control_unavailable"));
      try {
        const value=JSON.parse(stdout);
        const jobs=(section==='notifications'||value.notifications)?await allJobs().catch(()=>[]):[];
        if(section==='notifications'){
          if(value.data)value.data=automationNotificationProjection(value.data,jobs);
          else Object.assign(value,automationNotificationProjection(value,jobs));
        }
        if(value.notifications)value.notifications=automationNotificationProjection(value.notifications,jobs);
        resolve(completeUsageAttention(value));
      } catch { reject(new Error("control_invalid_response")); }
    });
  });
}

const OWNER_BACKLOG = 60;

export function streamControl(req: IncomingMessage, res: ServerResponse) {
  if (activeStreams >= 2) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "control_stream_busy" }));
    return;
  }
  // view=owner: local owner view with tags and scrubbed previews (Runtime tools); default stays payload-free.
  const owner = new URL(req.url || "/", "http://localhost").searchParams.get("view") === "owner";
  // The owner view starts with the last transcript lines (real timestamps, replay:true) so it is never empty on open.
  const args = owner ? ["--owner-json", "--history", String(OWNER_BACKLOG)] : ["--control-json"];
  const child = spawn("python3", ["-u", controlPaths().live, ...args], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  activeStreams++;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    activeStreams--;
    clearInterval(heartbeat);
    lines.close();
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
    const kill = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
    }, 2500);
    kill.unref();
    if (!res.writableEnded) res.end();
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
    "Connection": "keep-alive", "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const lines = readline.createInterface({ input: child.stdout });
  const heartbeat = setInterval(() => {
    if (!res.write(": keep-alive\n\n")) close();
  }, 10000);
  heartbeat.unref();
  let count = 0, windowStart = Date.now();
  lines.on("line", line => {
    if (closed) return;
    if (line.length > 8192) return close();
    try {
      const event = JSON.parse(line);
      if (event.type === "ready") {
        res.write("event: ready\ndata: {}\n\n");
        return;
      }
      if (!event.id || event.source !== "claw-live") return close();
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); count = 0; }
      // Bound the app queue; don't silently represent a truncated stream as complete.
      if (++count > 120) {
        res.write("event: gap\ndata: {}\n\n");
        return close();
      }
      if (!res.write("event: activity\ndata: " + JSON.stringify(event) + "\n\n")) close();
    } catch { close(); }
  });
  child.stderr.resume(); // Never return raw diagnostics to Android.
  child.once("error", close);
  child.once("exit", close);
  res.once("close", close);
  req.once("aborted", close);
}


type ControlEnvelope = {schemaVersion:2;resourceKey:string;dataRevision:string;remainingFreshMs:number;
  availability:string;freshness:string;data?:unknown;notModified?:boolean;[key:string]:unknown};
type ControlResult = {schemaVersion:2;sections:Record<string,ControlEnvelope>;computation?:Record<string,unknown>};
type Waiter = {resolve:(value:ControlResult)=>void;reject:(error:Error)=>void;off:()=>void;shared:boolean};
type Flight = {key:string;id:string;created:number;started:number;running:boolean;done:boolean;
  controller:AbortController;waiters:Set<Waiter>;timer:ReturnType<typeof setTimeout>;
  generate:(signal:AbortSignal)=>Promise<ControlResult>;cache:boolean};
function controlError(code:string,statusCode=503):Error {return Object.assign(new Error(code),{statusCode});}

/** Bounded read sharing owned by the existing Control facade, never an execution engine. */
export class ControlReadPool {
  private flights=new Map<string,Flight>();
  private cache=new Map<string,{value:ControlResult;at:number;until:number;bytes:number}>();
  private active=0;
  private cacheBytes=0;
  private generationCount=0;
  constructor(private budgetMs=6500,private maximum=2,private maxKeys=16,private maxBytes=2*1024*1024) {}
  stats(){return {active:this.active,pending:this.flights.size,cacheKeys:this.cache.size,cacheBytes:this.cacheBytes,generations:this.generationCount};}
  private copy(value:ControlResult,age:number,mode:string):ControlResult {
    const out:ControlResult=JSON.parse(JSON.stringify(value));
    for(const section of Object.values(out.sections))section.remainingFreshMs=Math.max(0,section.remainingFreshMs-Math.ceil(age));
    out.computation={...out.computation,deliveryMode:mode};
    return out;
  }
  private drop(key:string){const entry=this.cache.get(key);if(entry)this.cacheBytes-=entry.bytes;this.cache.delete(key);}
  invalidate(key?:string){
    if(key)this.drop(key);else{this.cache.clear();this.cacheBytes=0;}
    for(const f of [...this.flights.values()])if(!key||f.key===key)this.cancel(f,controlError("control_invalidated",409));
  }
  read(key:string,generate:(signal:AbortSignal)=>Promise<ControlResult>,signal?:AbortSignal,
       options:{force?:boolean;cache?:boolean}={}):Promise<ControlResult> {
    if(signal?.aborted)return Promise.reject(controlError("control_read_cancelled",499));
    const now=performance.now();
    for(const [k,v] of this.cache)if(v.until<=now)this.drop(k);
    const hit=this.cache.get(key);
    if(options.cache&&!options.force&&hit){this.cache.delete(key);this.cache.set(key,hit);return Promise.resolve(this.copy(hit.value,now-hit.at,"cache"));}
    if(options.force)this.drop(key);
    let flight=this.flights.get(key);
    const shared=Boolean(flight);
    if(!flight){
      if(this.flights.size>=this.maxKeys)return Promise.reject(controlError("control_read_busy",429));
      flight={key,id:randomUUID(),created:now,started:0,running:false,done:false,controller:new AbortController(),
        waiters:new Set(),timer:null as any,generate,cache:Boolean(options.cache)};
      this.flights.set(key,flight);
      const owned=flight;
      flight.timer=setTimeout(()=>this.cancel(owned,controlError("control_budget_exceeded",504)),this.budgetMs);
    }
    const owned=flight;
    return new Promise((resolve,reject)=>{
      const abort=()=>{
        owned.waiters.delete(waiter);waiter.off();reject(controlError("control_read_cancelled",499));
        if(!owned.waiters.size)this.cancel(owned,controlError("control_read_cancelled",499));
      };
      const waiter:Waiter={resolve,reject,shared,off:()=>signal?.removeEventListener("abort",abort)};
      owned.waiters.add(waiter);signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted)abort();else this.pump();
    });
  }
  private cancel(f:Flight,error:Error){
    if(f.done)return;
    f.done=true;clearTimeout(f.timer);
    if(this.flights.get(f.key)===f)this.flights.delete(f.key);
    f.controller.abort();
    for(const w of f.waiters){w.off();w.reject(error);}f.waiters.clear();
    // A running collector keeps its slot until its process actually settles.
    this.pump();
  }
  private pump(){
    for(const f of this.flights.values()){
      if(this.active>=this.maximum)return;
      if(f.running||f.done)continue;
      f.running=true;f.started=performance.now();this.active++;this.generationCount++;
      void this.execute(f);
    }
  }
  private async execute(f:Flight){
    try{
      const result=await f.generate(f.controller.signal);
      if(f.done||f.controller.signal.aborted)return;
      if(result.schemaVersion!==2||!result.sections)throw controlError("control_invalid_response");
      const value:ControlResult={...result,computation:{...result.computation,computationId:f.id,
        queueMs:Math.round((f.started-f.created)*1000)/1000}};
      if(f.cache){
        const ttl=Math.min(15000,...Object.values(value.sections).map(s=>s.availability==="ready"&&s.freshness==="fresh"?Number(s.remainingFreshMs)||0:0));
        const bytes=Buffer.byteLength(JSON.stringify(value));
        if(ttl>0&&bytes<=this.maxBytes){
          this.drop(f.key);
          while(this.cache.size>=this.maxKeys||this.cacheBytes+bytes>this.maxBytes)this.drop(this.cache.keys().next().value!);
          const at=performance.now();this.cache.set(f.key,{value,at,until:at+ttl,bytes});this.cacheBytes+=bytes;
        }
      }
      for(const w of f.waiters){w.off();w.resolve(this.copy(value,0,w.shared?"coalesced":"generated"));}
    }catch(e){
      if(!f.done)for(const w of f.waiters){w.off();w.reject(e instanceof Error?e:controlError("control_unavailable"));}
    }finally{
      f.done=true;clearTimeout(f.timer);f.waiters.clear();
      if(this.flights.get(f.key)===f)this.flights.delete(f.key);
      this.active--;this.pump();
    }
  }
}
const controlReads=new ControlReadPool();

/** Derived read-only presentations share the existing bounded Control pool. */
export async function readControlProjection(key:string,generate:(signal:AbortSignal)=>Promise<unknown>,signal?:AbortSignal):Promise<any>{
  const result=await controlReads.read('projection:'+key,async abort=>{
    const data=await generate(abort);
    return {schemaVersion:2,sections:{projection:{schemaVersion:2,resourceKey:key,dataRevision:createHash('sha256').update(JSON.stringify(data)).digest('hex'),remainingFreshMs:15000,availability:'ready',freshness:'fresh',data}}};
  },signal,{cache:true});
  return result.sections.projection.data;
}


// A revision input, never a replacement scheduler or a second copy of its jobs.
async function automationSourceRevision():Promise<string|null>{
  const root=process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),".openclaw");
  const directory=path.join(root,"cron"),source=path.join(directory,"jobs.json");
  let file:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{
    for(const parent of [root,directory]){const info=await fs.lstat(parent);if(!info.isDirectory()||info.isSymbolicLink())return null;}
    file=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await file.stat();if(!info.isFile()||info.size>8*1024*1024)return null;
    const data=await file.readFile();if(data.length>8*1024*1024)return null;
    return createHash("sha256").update(data).digest("hex");
  }catch{return null;}finally{await file?.close();}
}

function deferredAutomations(revision:string|null):ControlResult{
  return {schemaVersion:2,sections:{automations:{schemaVersion:2,resourceKey:"control/v2/automations",
    dataRevision:createHash("sha256").update("deferred:"+(revision||"unavailable")).digest("hex"),
    availability:"unavailable",freshness:"unknown",remainingFreshMs:0,
    reason:revision?"computation_pending":"source_revision_unavailable"}},
    computation:{deliveryMode:"deferred",retryAfterMs:250}};
}

export async function readControlV2(selected:string[],detailId:string|undefined,signal?:AbortSignal,force=false):Promise<ControlResult>{
  const names=[...new Set(selected)].sort();
  if(!names.length||names.some(n=>n==="snapshot"||!sections.has(n)))return Promise.reject(controlError("unsupported_control_section",400));
  if(detailId&&(!/^[A-Za-z0-9_.:-]{1,160}$/.test(detailId)||names.length!==1||!["requests","missions","situations"].includes(names[0])))
    return Promise.reject(controlError("invalid_control_detail",400));
  const roots=controlPaths();
  const fastAutomations=names.length===1&&names[0]==="automations";
  const sourceRevision=fastAutomations?await automationSourceRevision():null;
  // Without a readable revision source, the fast path would answer "deferred" forever: read normally instead.
  const fast=fastAutomations&&sourceRevision!==null;
  const key=JSON.stringify(["native-loopback",roots.playbooks,roots.live,2,names,detailId||null,sourceRevision]);
  const generate=(abort:AbortSignal)=>new Promise<ControlResult>((resolve,reject)=>{
    const args=["-m","reporting.control_snapshot","--contract","2","--sections",names.join(",")];
    if(detailId)args.push("--detail-id",detailId);
    // The scheduler list for the P2-a switches is read while Python runs, not after it (S24 Gateway calls take seconds).
    const jobsRead=names.includes("notifications")?allJobs().catch(()=>[]):Promise.resolve([]);
    let settled=false,outputBytes=0,failure:Error|undefined;
    const chunks:Buffer[]=[];
    const child=spawn("python3",args,{cwd:roots.playbooks,env:{...process.env,SAMANTHA_CONTROL_LIVE:roots.live},
      detached:true,stdio:["ignore","pipe","pipe"]});
    const killGroup=()=>{try{if(child.pid)process.kill(-child.pid,"SIGKILL");}catch{/* already exited */}};
    const cancel=()=>{failure=controlError("control_read_cancelled",499);if(!settled)killGroup();};
    const timer=setTimeout(()=>{failure=controlError("control_budget_exceeded",504);killGroup();},6500);
    const finish=(error?:Error)=>{
      if(settled)return;settled=true;clearTimeout(timer);abort.removeEventListener("abort",cancel);
      if(error||failure||abort.aborted){killGroup();reject(error||failure||controlError("control_read_cancelled",499));return;}
      try{
        const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const requestData=value.sections?.requests?.data;
        const requestItems=[requestData?.item,...(Array.isArray(requestData?.items)?requestData.items:[])];
        if(requestItems.some(requestItem=>requestItem?.sessionId!=null && (typeof requestItem.sessionId!=="string" || !/^[A-Za-z0-9_-]{1,80}$/.test(requestItem.sessionId))))
          throw controlError("control_invalid_request_origin");
        if(value.sections?.diagnostic?.data?.components) {
          const component=value.sections.diagnostic.data.components.find((row:any)=>row.id==="companion");
          if(component){component.version=companionBuildVersion();component.endpoint="/v1";}
          value.sections.diagnostic.dataRevision=createHash("sha256").update(JSON.stringify(value.sections.diagnostic.data)).digest("hex");
        }
        const project=value.sections?.notifications?.data
          ? jobsRead.then(jobs=>{value.sections.notifications.data=automationNotificationProjection(value.sections.notifications.data,jobs);return value;})
          : Promise.resolve(value);
        project.then(value=>completeHealthSection(value,path.join(os.homedir(),".openclaw/health/current.json")))
          .then(resolve,()=>reject(controlError("control_invalid_response")));
      }catch{reject(controlError("control_invalid_response"));}
    };
    child.stdout.on("data",(data:Buffer)=>{
      outputBytes+=data.length;
      if(outputBytes>1024*1024){failure=controlError("control_response_limit");killGroup();}
      else chunks.push(data);
    });
    child.stderr.resume(); // Diagnostics never cross the facade.
    child.once("error",()=>finish(controlError("control_unavailable")));
    child.once("close",code=>finish(code===0?undefined:controlError("control_unavailable")));
    abort.addEventListener("abort",cancel,{once:true});if(abort.aborted)cancel();
  });
  const guardedGenerate=async(abort:AbortSignal)=>{
    const value=await generate(abort);
    if(fast&&await automationSourceRevision()!==sourceRevision)throw controlError("control_invalidated",409);
    return value;
  };
  const result=controlReads.read(key,guardedGenerate,signal,{force,cache:fast||process.env.SAMANTHA_CONTROL_CACHE==="1"});
  if(!fast)return result.then(completeUsageAttention);
  // The existing bounded collector continues; polling shares its single flight.
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([result,new Promise<ControlResult>(resolve=>{
    timer=setTimeout(()=>resolve(deferredAutomations(sourceRevision)),180);
  })]);}finally{if(timer)clearTimeout(timer);}
}

export async function handleControl(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
  const routeOnly=route.split("?")[0];
  if (!routeOnly.startsWith("/control/")) return false;
  const address=req.socket.remoteAddress||"";
  if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(address)||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){res.writeHead(403);res.end();return true;}
  if(req.method!=="GET"){res.writeHead(405,{Allow:"GET"});res.end();return true;}
  const target=routeOnly.slice("/control/".length);
  if(target==="activity/stream"){streamControl(req,res);return true;}
  const params=new URL(req.url||route,"http://localhost").searchParams;
  const version=params.get("contract")||"1";
  if(!["1","2"].includes(version)){res.writeHead(400);res.end();return true;}
  if(version==="2"&&process.env.SAMANTHA_CONTROL_V2==="0"){res.writeHead(404);res.end();return true;}
  const bits=target.split("/");
  if(!sections.has(bits[0])||bits.length>2||(bits.length===2&&!['requests','missions','situations'].includes(bits[0]))){res.writeHead(404);res.end();return true;}
  const abort=new AbortController();
  const cancel=()=>{if(!res.writableEnded)abort.abort();};res.once("close",cancel);
  try{
    let value:unknown;
    if(version==="1"){
      if(bits.length!==1){res.writeHead(404);res.end();return true;}
      value=await readControl(target,abort.signal);
    }else{
      for(const [key] of params)if(!["contract","sections","knownRevision","force"].includes(key))throw controlError("unsupported_control_parameter",400);
      if(params.get("force")&&!['0','1'].includes(params.get("force")!))throw controlError("invalid_force",400);
      const names=bits[0]==="snapshot"?(params.get("sections")||"").split(","): [bits[0]];
      if(bits[0]!=="snapshot"&&params.has("sections"))throw controlError("invalid_sections",400);
      const detail=bits[1]?decodeURIComponent(bits[1]):undefined;
      const known=params.get("knownRevision");
      if(known&&(!/^[a-f0-9]{64}$/.test(known)||names.length!==1))throw controlError("invalid_revision",400);
      const result=await readControlV2(names,detail,abort.signal,params.get("force")==="1");
      if(known){
        const section=result.sections[names[0]];
        if(section?.dataRevision===known&&section.availability==="ready"&&section.freshness==="fresh"&&section.remainingFreshMs>0){
          delete section.data;section.notModified=true;
        }
      }
      value=result;
    }
    if(!res.destroyed){const body=JSON.stringify(value);res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");if(!conditionalRead(req,res,200,value,body)){res.statusCode=200;res.end(body);}}
  }catch(error:any){
    if(!res.destroyed){const code=[400,404,429,499,504].includes(error?.statusCode)?error.statusCode:503;
      res.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify({error:code===400?"invalid_control_request":code===429?"control_read_busy":"control_unavailable"}));}
  }finally{res.removeListener("close",cancel);}
  return true;
}
