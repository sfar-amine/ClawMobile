import {callOpenClawGateway} from "./openclawAgentClient";

// A process-local view of the existing owner, never a second metadata store.
// Only a successful canonical read changes rows; transport failures retain them.
const TTL_MS=2000;
type OwnerRow={key:string,label?:string,pinned?:boolean,[field:string]:any};
let rows=new Map<string,OwnerRow>(),complete=false;
const dirty=new Map<string,number>();let dirtyVersion=0;
let nextRefreshAt=0,flight:Promise<void>|undefined,observed=false,failed=false,epoch=0;
const versions=new Map<string,number>();
function row(value:any){
 if(!value||typeof value.key!=="string"||value.key.length===0||value.key.length>512)throw Error("conversation_owner_index_unavailable");
 const extra:Record<string,any>={};
 for(const field of ['sessionId','model','modelProvider','modelOverride','providerOverride','authProfileOverride','modelOverrideSource','thinkingLevel','thinkingDefault'])if(typeof value[field]==='string'&&value[field].length<=200&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(value[field]))extra[field]=value[field];
 for(const field of ['hasActiveRun','permissionModePending','totalTokensFresh'])if(typeof value[field]==='boolean')extra[field]=value[field];
 for(const field of ['totalTokens','contextTokens','snapshotAt'])if(Number.isSafeInteger(value[field])&&value[field]>=0)extra[field]=value[field];
 if(Array.isArray(value.thinkingLevels)&&value.thinkingLevels.length<=32)extra.thinkingLevels=value.thinkingLevels.flatMap((level:any)=>typeof level?.id==='string'&&/^[a-z]{1,40}$/.test(level.id)?[{id:level.id}]:[]);
 return {key:value.key,...extra,...(typeof value.label==='string'&&value.label.length<=160&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(value.label)?{label:value.label}:{}),...(typeof value.pinned==='boolean'?{pinned:value.pinned}:{})};
}
function bounded(next:typeof rows){
 while(next.size>100){const key=next.keys().next().value!;next.delete(key);versions.delete(key);}
 return next;
}
export function observeConversationOwnerRow(value:any){
 const owner=row(value);rows=new Map(rows);rows.set(owner.key,owner);versions.set(owner.key,++epoch);rows=bounded(rows);observed=true;
}
export function conversationOwnerIndex(){
 if(!flight&&Date.now()>=nextRefreshAt){
  nextRefreshAt=Date.now()+TTL_MS;
  const startedEpoch=epoch,startedDirty=new Map(dirty);
  flight=(async()=>{
   try{
    const value=await callOpenClawGateway('sessions.list',{search:'companion-',limit:100},{timeoutMs:5500,hardTimeoutMs:5500});
    if(!Array.isArray(value?.sessions)||value.sessions.length>100)throw Error("conversation_owner_index_unavailable");
    const owners=value.sessions.map(row),next=new Map<string,ReturnType<typeof row>>(owners.map((owner:any)=>[owner.key,owner]));
    if(next.size!==owners.length)throw Error("conversation_owner_index_unavailable");
    for(const [key,owner] of rows)if((versions.get(key)||0)>startedEpoch)next.set(key,owner);
    complete=value.sessions.length<100;rows=bounded(next);for(const key of versions.keys())if(!rows.has(key))versions.delete(key);observed=true;failed=false;
   }catch{ failed=true; /* Keep the last successful owner view and its metadata revision. */ }
   finally{for(const [key,version] of startedDirty)if(dirty.get(key)===version)dirty.delete(key);nextRefreshAt=Date.now()+TTL_MS;flight=undefined;}
  })();
 }
 return {rows,state:observed?(flight?'refreshing':failed?'stale':'observed'):'pending'};
}


/** Existing run-owner terminal transitions only invalidate this volatile view. */
export function invalidateConversationOwner(key:string){
 if(typeof key!=="string"||key.length>512)return;
 dirty.set(key,++dirtyVersion);
 while(dirty.size>100)dirty.delete(dirty.keys().next().value!);
}

/** One shared CLI read at cold start or after a known run end; warm view is immediate. */
export async function readConversationOwnerRow(key:string){
 const invalidated=dirty.has(key);
 if(invalidated&&!flight)nextRefreshAt=0;
 const view=conversationOwnerIndex();
 if(flight&&(invalidated||!view.rows.has(key)))await new Promise<void>((resolve)=>{
  const timer=setTimeout(resolve,5500);
  flight!.then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);resolve();});
 });
 const needsRefresh=dirty.has(key);
 const state=needsRefresh?'pending':observed?(failed?'stale':flight?'refreshing':'observed'):'pending';
 const owner=rows.get(key);
 return {row:owner?{...owner,...(needsRefresh?{totalTokensFresh:false}:{})} as OwnerRow:null,state,notFound:!owner&&complete&&state==='observed'};
}
