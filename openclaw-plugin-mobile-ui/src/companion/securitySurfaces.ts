import fs from "fs/promises";
import {constants} from "fs";
import path from "path";
import {remoteBridgeReceiptDirectory} from "./remoteBridge";
import {notificationSources} from "./notificationSources";

const safeId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9._-]{1,24}$/.test(v)&&!/[0-9]{8}|token|secret|bearer/i.test(v);
const iso=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=Date.now()+1000?new Date(v).toISOString():null;
let transportCache:{until:number;value:any[]}|undefined;
let transportRead:Promise<any[]>|undefined;
function transportProjection(value:any){
 if(!Array.isArray(value?.items))throw Error();
 return ['whatsapp','slack'].map(id=>{const row=value.items.find((v:any)=>v?.id===id&&v.kind==='channel');return {id,kind:'transport',label:id==='whatsapp'?'WhatsApp':'Slack',enabled:typeof row?.enabled==='boolean'?row.enabled:null,lastActivityAt:typeof row?.lastDeliveryAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.lastDeliveryAt)&&!isNaN(Date.parse(row.lastDeliveryAt))?new Date(row.lastDeliveryAt).toISOString():null,revocable:false,reason:'transport_configuration_read_only'};});
}
async function transports(){
 if(transportCache&&transportCache.until>Date.now())return transportCache.value;
 if(!transportRead){transportRead=notificationSources().then(value=>{const projected=transportProjection(value);transportCache={until:Date.now()+15000,value:projected};return projected;}).catch(()=>transportProjection({items:[]})).finally(()=>{transportRead=undefined;});}
 let timer:ReturnType<typeof setTimeout>;
 const value=await Promise.race([transportRead,new Promise<any[]>(resolve=>{timer=setTimeout(()=>resolve(transportProjection({items:[]})),1000);})]);
 clearTimeout(timer!);return value;
}
async function clients(){
 const rows=new Map<string,any>(),issues:string[]=['mcp_config_not_readable'];
 const directory=remoteBridgeReceiptDirectory();
 try{
  for(let parent=directory;;parent=path.dirname(parent)){const stat=await fs.lstat(parent);if(stat.isSymbolicLink())throw Error();if(path.dirname(parent)===parent)break;}
  const deadline=Date.now()+350;
  const entries=await fs.readdir(directory,{withFileTypes:true});
  const eligible=entries.filter(entry=>entry.isFile()&&/^[-A-Za-z0-9._:]{1,128}\.json$/.test(entry.name));
  const candidates:{name:string;mtime:number}[]=[];
  let complete=true,bytes=0;
  // Directory order does not indicate recency: rank the entire eligible directory.
  for(let offset=0;offset<eligible.length;offset+=64){
   if(Date.now()>deadline-100){complete=false;break;}
   const batch=await Promise.all(eligible.slice(offset,offset+64).map(async entry=>{
    try{const stat=await fs.lstat(path.join(directory,entry.name));return stat.isFile()?{name:entry.name,mtime:stat.mtimeMs}:null;}catch{return null;}
   }));
   candidates.push(...batch.filter((v):v is {name:string;mtime:number}=>v!==null));
  }
  candidates.sort((a,b)=>b.mtime-a.mtime||a.name.localeCompare(b.name));
  if(candidates.length>500)complete=false;
  for(const entry of candidates.slice(0,500)){
   if(Date.now()>deadline){complete=false;break;}
   let handle;
   try{
    handle=await fs.open(path.join(directory,entry.name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await handle.stat();if(!info.isFile()||info.size>256*1024){issues.push('mcp_receipt_unreadable');continue;}
    bytes+=info.size;if(bytes>8*1024*1024){complete=false;break;}
    const raw=await handle.readFile();if(raw.length>256*1024)continue;
    const value=JSON.parse(raw.toString('utf8'));
    const id=typeof value.sessionId==='string'&&value.sessionId.startsWith('external_mcp:')?value.sessionId.slice(13):null;
    if(!safeId(id))continue;
    const when=iso(value.receivedAt);if(!when||value.receivedAt<Date.now()-30*24*60*60*1000)continue;
    const access=value._claw_access;
    let profile:string|null=null;
    if(access?.client_id===id&&['chat-owner','chat-owner-shadow'].includes(access.profile)&&access.owner===(access.profile==='chat-owner')&&access.read_only===(access.profile!=='chat-owner'))profile=access.profile;
    // Legacy method names do not attest caller identity: HTTP can submit them too.
    const previous=rows.get(id);if(previous&&Date.parse(previous.lastActivityAt)>=value.receivedAt)continue;
    rows.set(id,{id,kind:'mcp_client',label:id==='claude-chat'?'Claude':id==='chatgpt-chat'?'ChatGPT':id==='codex-cloud'?'Codex': 'Client Claw',profile,owner:profile?profile==='chat-owner':null,readOnly:profile?profile!=='chat-owner':null,lastActivityAt:when,revocable:false,reason:'revocation_not_available'});
    if(!profile)issues.push('mcp_profile_unavailable');
   }catch{issues.push('mcp_receipt_unreadable');}finally{await handle?.close();}
  }
  if(!complete){issues.push('mcp_receipt_scan_limited');for(const row of rows.values())row.lastActivityAt=null;}
 }catch{issues.push('mcp_receipts_unavailable');}
 return {items:[...rows.values()].sort((a,b)=>a.id.localeCompare(b.id)),issues:[...new Set(issues)]};
}
export async function securitySurfaces(){
 const [mcp,transport]=await Promise.all([clients(),transports()]);
 const issues=[...mcp.issues,...(transport.some(v=>v.enabled===null)?['transport_state_unavailable']:[])];
 return {success:true,state:issues.length===1?'ok':'partial',receipt:null,items:[...mcp.items,...transport],issues};
}
