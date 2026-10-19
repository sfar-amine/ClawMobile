import {adb_shell} from "../backends/adb";
import dgram from "node:dgram";
import os from "node:os";
import crypto from "node:crypto";
import {existingNativeOperation,nativeOperation,nativeError} from "./nativeOperation";

type Endpoint={id:string;ip:string;port:number;local:string};
type WireState={hue:number;saturation:number;brightness:number;kelvin:number;power:"on"|"off";label:string};
const endpoints=new Map<string,Endpoint>(); // bounded transport cache; canonical identity is the MAC
let busy=false;
const fail=(message:string,statusCode=400)=>nativeError(message,statusCode);
export function lifxPacket(id:string,type:number,source:number,sequence:number,payload:Buffer=Buffer.alloc(0),tagged=false){
 const h=Buffer.alloc(36);h.writeUInt16LE(36+payload.length,0);h.writeUInt16LE(tagged?0x3400:0x1400,2);
 h.writeUInt32LE(source,4);Buffer.from(id,"hex").copy(h,8);h[22]=1;h[23]=sequence;h.writeUInt16LE(type,32);return Buffer.concat([h,payload]);
}
export function wifiRoute(text:string){
 const line=text.split(/\r?\n/).find(l=>/\bdev wlan0\b/.test(l)&&/\bsrc [0-9.]+/.test(l));
 const match=line?.match(/^([0-9.]+)\/(\d+)\s+dev wlan0\b.*\bsrc ([0-9.]+)/);
 if(!match)throw fail("LOCAL_NETWORK_UNAVAILABLE",503);
 const prefix=Number(match[2]),parts=match[3].split(".").map(Number);
 if(prefix<1||prefix>30||parts.length!==4||parts.some(x=>!Number.isInteger(x)||x<0||x>255))throw fail("LOCAL_NETWORK_UNAVAILABLE",503);
 const ip=parts.reduce((v,x)=>(v*256+x)>>>0,0),mask=(0xffffffff<<(32-prefix))>>>0,broadcast=(ip|~mask)>>>0;
 return {local:match[3],broadcast:[24,16,8,0].map(b=>String((broadcast>>>b)&255)).join(".")};
}
async function wifi(){
 const rows=Object.entries(os.networkInterfaces()).filter(([name])=>/^wlan\d+$/.test(name)).flatMap(([,v])=>v||[]);
 const row=rows.find(x=>x.family==="IPv4"&&!x.internal);
 if(row)return {local:row.address,broadcast:row.address.split(".").map((v,i)=>String((Number(v)|(~Number(row.netmask.split(".")[i])&255)))).join(".")};
 // Android hides wlan0 from Termux getifaddrs. Read routes via the existing ADB backend; never alter network state.
 let timer:ReturnType<typeof setTimeout>;
 try{
  const result=await Promise.race([adb_shell({args:["ip","route"],timeoutMs:350}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(fail("LOCAL_NETWORK_UNAVAILABLE",503)),550);})]);
  if(!result.ok)throw fail("LOCAL_NETWORK_UNAVAILABLE",503);
  return wifiRoute(result.stdout);
 }finally{clearTimeout(timer!);}
}
function boundSocket(local:string):Promise<dgram.Socket>{
 return new Promise((resolve,reject)=>{const s=dgram.createSocket("udp4");s.once("error",e=>{s.close();reject(e);});s.bind(0,local,()=>resolve(s));});
}
function validReply(d:Buffer,source:number,sequence:number,type:number,id?:string){
 return d.length>=36&&d.length<=1024&&d.readUInt16LE(0)===d.length&&(d.readUInt16LE(2)&0xfff)===1024&&
 d.readUInt32LE(4)===source&&d[23]===sequence&&d.readUInt16LE(32)===type&&(!id||d.subarray(8,14).toString("hex")===id);
}
export async function discoverLifx(budget=600){
 const {local,broadcast}=await wifi(),s=await boundSocket(local),source=crypto.randomBytes(4).readUInt32LE(),found=new Map<string,Endpoint>();
 try{
  s.setBroadcast(true);
  s.on("message",(d,a)=>{if(!validReply(d,source,1,3)||d.length<41||d[36]!==1)return;
   const id=d.subarray(8,14).toString("hex"),port=d.readUInt32LE(37);if(!port||port>65535||found.size>=32)return;
   found.set(id,{id,ip:a.address,port,local});});
  await new Promise<void>((resolve,reject)=>{s.send(lifxPacket("000000000000",2,source,1,undefined,true),56700,broadcast,e=>e?reject(e):undefined);setTimeout(resolve,budget);});
  endpoints.clear();for(const [id,e] of found)endpoints.set(id,e);return [...found.values()];
 }finally{s.close();}
}
async function exchange(e:Endpoint,type:number,reply:number,payload:Buffer,timeout:number):Promise<Buffer>{
 const s=await boundSocket(e.local),source=crypto.randomBytes(4).readUInt32LE(),seq=crypto.randomBytes(1)[0];
 try{return await new Promise<Buffer>((resolve,reject)=>{
  const finish=(err:Error|null,d?:Buffer)=>{clearTimeout(timer);s.removeAllListeners("message");s.removeAllListeners("error");err?reject(err):resolve(d!);};
  const timer=setTimeout(()=>finish(fail("DEVICE_UNREACHABLE",503)),Math.max(1,timeout));
  s.on("error",err=>finish(err));s.on("message",(d,a)=>{if(a.address===e.ip&&a.port===e.port&&validReply(d,source,seq,reply,e.id))finish(null,d.subarray(36));});
  s.send(lifxPacket(e.id,type,source,seq,payload),e.port,e.ip,err=>{if(err)finish(err);});
 });}finally{s.close();}
}
function remaining(deadline:number){const ms=deadline-Date.now();if(ms<=0)throw fail("VERIFICATION_TIMEOUT",503);return ms;}
async function endpoint(id:string,deadline:number){
 if(!/^[0-9a-f]{12}$/.test(id))throw fail("INVALID_DEVICE_ID");
 const net=await wifi(),cached=endpoints.get(id);if(cached?.local===net.local)return cached;
 const rows=await discoverLifx(Math.min(600,remaining(deadline)));const e=rows.find(x=>x.id===id);if(!e)throw fail("DEVICE_NOT_FOUND",503);return e;
}
export function decodeLifxState(p:Buffer):WireState{
 if(p.length<44)throw fail("INVALID_DEVICE_REPLY",503);
 return {hue:p.readUInt16LE(0),saturation:p.readUInt16LE(2),brightness:p.readUInt16LE(4),kelvin:p.readUInt16LE(6),
 power:p.readUInt16LE(10)?"on":"off",label:p.subarray(12,44).toString("utf8").replace(/\0.*$/s,"")};
}
async function readWire(e:Endpoint,deadline:number){return decodeLifxState(await exchange(e,101,107,Buffer.alloc(0),Math.min(700,remaining(deadline))));}
function state(s:WireState){return {availability:"online",freshness:"fresh",power:s.power,label:s.label,
 brightness_percent:s.brightness/65535*100,color:{hue_deg:s.hue/65535*360,saturation_percent:s.saturation/65535*100,kelvin:s.kelvin},
 raw_hsbk:{hue:s.hue,saturation:s.saturation,brightness:s.brightness,kelvin:s.kelvin}};}
export async function readLifx(id:string,diagnostics=false){
 const started=Date.now(),deadline=started+2500;
 try{
  let e=await endpoint(id,deadline),raw:WireState;
  try{raw=await readWire(e,deadline);}catch{
   endpoints.delete(id);e=await endpoint(id,deadline);raw=await readWire(e,deadline);
  }
  const result:any={contract_version:"0.1",device_id:id,status:"observed",transport:"lifx_lan_udp",observed_at:new Date().toISOString(),state:state(raw),error:null};
  if(diagnostics){
   const [version,firmware,signal,info]=await Promise.all([[32,33],[14,15],[16,17],[34,35]].map(async([t,r])=>
    exchange(e,t,r,Buffer.alloc(0),Math.min(500,remaining(deadline))).catch(()=>null)));
   const v=signal&&signal.length>=4?signal.readFloatLE(0):null;
   result.diagnostics={product_id:version&&version.length>=12?version.readUInt32LE(4):null,
    firmware:firmware&&firmware.length>=20?firmware.readUInt16LE(18)+"."+firmware.readUInt16LE(16):null,
    signal_raw:v,rssi_dbm:v!==null&&v>0?Math.round(10*Math.log10(v)):null,
    uptime_seconds:info&&info.length>=24?Number(info.readBigUInt64LE(8))/1e9:null,internal_logs_available:false};
  }
  result.elapsed_ms=Date.now()-started;return result;
 }catch(err:any){return {contract_version:"0.1",device_id:id,status:"failed",transport:"lifx_lan_udp",observed_at:null,state:null,
  elapsed_ms:Date.now()-started,error:{code:err.message||"DEVICE_UNREACHABLE",message:"Lampe injoignable sur le réseau local.",retryable:true}};}
}
export function validateLifxSet(body:any){
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["contract_version","request_id","device_id","origin","expires_at","desired","transition_ms"].includes(k)))throw fail("INVALID_ARGUMENT");
 if(body.contract_version!=="0.1"||typeof body.request_id!=="string"||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body.request_id)||
 !/^[0-9a-f]{12}$/.test(body.device_id)||!["screen","voice","agent"].includes(body.origin))throw fail("INVALID_ARGUMENT");
 const desired=body.desired;
 if(!desired||typeof desired!=="object"||Array.isArray(desired)||!Object.keys(desired).length||
 Object.keys(desired).some(k=>!["power","brightness_percent","color"].includes(k)))throw fail("INVALID_ARGUMENT");
 const numeric=(x:any,min:number,max:number)=>typeof x==="number"&&Number.isFinite(x)&&x>=min&&x<=max;
 if(desired.power!==undefined&&!["on","off"].includes(desired.power))throw fail("INVALID_ARGUMENT");
 if(desired.brightness_percent!==undefined&&!numeric(desired.brightness_percent,0,100))throw fail("INVALID_ARGUMENT");
 const c=desired.color;
 if(c!==undefined){
  if(!c||typeof c!=="object"||Array.isArray(c))throw fail("INVALID_ARGUMENT");
  if(c.mode==="white"){if(Object.keys(c).sort().join(",")!=="kelvin,mode"||!Number.isInteger(c.kelvin)||!numeric(c.kelvin,1500,9000))throw fail("INVALID_ARGUMENT");}
  else if(c.mode==="color"){if(Object.keys(c).sort().join(",")!=="hue_deg,mode,saturation_percent"||!numeric(c.hue_deg,0,359.999999)||!numeric(c.saturation_percent,0,100))throw fail("INVALID_ARGUMENT");}
  else throw fail("INVALID_ARGUMENT");
 }
 if(!Number.isInteger(body.transition_ms)||!numeric(body.transition_ms,0,2000))throw fail("INVALID_ARGUMENT");
 if(typeof body.expires_at!=="string"||!Number.isFinite(Date.parse(body.expires_at)))throw fail("INVALID_ARGUMENT");
 return body;
}
function desiredIdentity(b:any){return JSON.stringify({device_id:b.device_id,power:b.desired.power??null,
 brightness:b.desired.brightness_percent??null,color:b.desired.color?.mode==="white"?{mode:"white",kelvin:b.desired.color.kelvin}:
 b.desired.color?{mode:"color",hue_deg:b.desired.color.hue_deg,saturation_percent:b.desired.color.saturation_percent}:null,transition:b.transition_ms});}
export function targetWire(before:WireState,b:any):WireState{
 const d=b.desired,c=d.color;
 return {...before,power:d.power??before.power,brightness:d.brightness_percent===undefined?before.brightness:Math.round(d.brightness_percent/100*65535),
 hue:c?.mode==="color"?Math.round(c.hue_deg/360*65535):before.hue,
 saturation:c?.mode==="white"?0:c?.mode==="color"?Math.round(c.saturation_percent/100*65535):before.saturation,kelvin:c?.mode==="white"?c.kelvin:before.kelvin};
}
function matches(actual:WireState,target:WireState,b:any){
 const d=b.desired,c=d.color,deg=(v:number)=>v/65535*360,hue=Math.abs(deg(actual.hue)-deg(target.hue));
 return (d.power===undefined||actual.power===target.power)&&(d.brightness_percent===undefined||Math.abs(actual.brightness-target.brightness)<=656)&&
 (!c||(Math.abs(actual.saturation-target.saturation)<=656&&(c.mode==="white"?Math.abs(actual.kelvin-target.kelvin)<=50:
 target.saturation===0||Math.min(hue,360-hue)<=1)));
}
export async function setLifx(input:any){
 const b=validateLifxSet(input),identity=desiredIdentity(b),target=b.device_id+":"+crypto.createHash("sha256").update(identity).digest("hex");
 const prior=await existingNativeOperation(b.request_id,JSON.stringify({action:"samantha.app.lighting.set",target}));
 if(prior)return prior;
 const now=Date.now(),expiry=Date.parse(b.expires_at);
 if(expiry<=now||expiry>now+10000)throw fail("REQUEST_EXPIRED",409);
 if(busy)throw fail("DEVICE_BUSY",409);
 busy=true;
 try{return await nativeOperation(b.request_id,"samantha.app.lighting.set",target,async()=>{
  const started=Date.now(),deadline=Math.min(expiry,started+3000);let sent=false;let observed:WireState|null=null;
  try{
   const e=await endpoint(b.device_id,deadline);observed=await readWire(e,deadline);
   // Qualify actual product/firmware before writing. This first connector is scoped to the measured A19.
   const ver=await exchange(e,32,33,Buffer.alloc(0),Math.min(400,remaining(deadline)));
   const fw=await exchange(e,14,15,Buffer.alloc(0),Math.min(400,remaining(deadline)));
   if(ver.length<12||fw.length<20||ver.readUInt32LE(0)!==1||ver.readUInt32LE(4)!==27||fw.readUInt16LE(18)!==2||fw.readUInt16LE(16)<80)throw fail("UNSUPPORTED_CAPABILITY");
   const expected=targetWire(observed,b);
   if(matches(observed,expected,b))return {state:"completed" as const,artifact:{status:"verified",state:state(observed),device_id:b.device_id,transport:"lifx_lan_udp",observed_at:new Date().toISOString(),elapsed_ms:Date.now()-started,error:null}};
   if(remaining(deadline)<b.transition_ms+600)throw fail("REQUEST_EXPIRED",409);
   if(b.desired.color!==undefined||b.desired.brightness_percent!==undefined){
    const p=Buffer.alloc(13);p.writeUInt16LE(expected.hue,1);p.writeUInt16LE(expected.saturation,3);p.writeUInt16LE(expected.brightness,5);p.writeUInt16LE(expected.kelvin,7);p.writeUInt32LE(b.transition_ms,9);
    sent=true;await exchange(e,102,107,p,Math.min(500,remaining(deadline))).catch(()=>null);
   }
   if(b.desired.power!==undefined&&observed.power!==expected.power){
    remaining(deadline);const p=Buffer.alloc(6);p.writeUInt16LE(expected.power==="on"?65535:0);p.writeUInt32LE(b.transition_ms,2);
    sent=true;await exchange(e,117,118,p,Math.min(500,remaining(deadline))).catch(()=>null);
   }
   await new Promise(resolve=>setTimeout(resolve,b.transition_ms));
   observed=await readWire(e,deadline);
   const verified=matches(observed,expected,b);
   return {state:verified?"completed" as const:"accepted" as const,artifact:{status:verified?"verified":"unconfirmed",state:state(observed),device_id:b.device_id,
    transport:"lifx_lan_udp",observed_at:new Date().toISOString(),elapsed_ms:Date.now()-started,
    error:verified?null:{code:"PARTIAL_APPLICATION",message:"Changement non confirmé.",retryable:false}}};
  }catch(err:any){return {state:sent?"accepted" as const:"refused" as const,artifact:{status:sent?"unconfirmed":"failed",device_id:b.device_id,transport:"lifx_lan_udp",
   state:observed?{...state(observed),freshness:"stale"}:null,observed_at:null,elapsed_ms:Date.now()-started,
   error:{code:err.message||"DEVICE_UNREACHABLE",message:sent?"Changement non confirmé.":"Lampe injoignable ou commande refusée.",retryable:!sent}}};}
 });}finally{busy=false;}
}
