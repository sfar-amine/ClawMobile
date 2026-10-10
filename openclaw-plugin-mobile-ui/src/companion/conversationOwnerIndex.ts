import {callOpenClawGateway} from "./openclawAgentClient";

// A process-local view of the existing owner, never a second metadata store.
// Only a successful canonical read changes rows; transport failures retain them.
const TTL_MS=2000;
let rows=new Map<string,{key:string,label?:string,pinned?:boolean}>();
let nextRefreshAt=0,flight:Promise<void>|undefined,observed=false,failed=false,epoch=0;
const versions=new Map<string,number>();
function row(value:any){
 if(!value||typeof value.key!=="string")throw Error("conversation_owner_index_unavailable");
 return {key:value.key,...(typeof value.label==='string'?{label:value.label}:{}),...(typeof value.pinned==='boolean'?{pinned:value.pinned}:{})};
}
export function observeConversationOwnerRow(value:any){
 const owner=row(value);rows=new Map(rows);rows.set(owner.key,owner);versions.set(owner.key,++epoch);observed=true;
}
export function conversationOwnerIndex(){
 if(!flight&&Date.now()>=nextRefreshAt){
  nextRefreshAt=Date.now()+TTL_MS;
  const startedEpoch=epoch;
  flight=(async()=>{
   try{
    const value=await callOpenClawGateway('sessions.list',{search:'companion-',limit:100},{timeoutMs:10000,hardTimeoutMs:10000});
    if(!Array.isArray(value?.sessions)||value.sessions.length>100)throw Error("conversation_owner_index_unavailable");
    const owners=value.sessions.map(row),next=new Map<string,ReturnType<typeof row>>(owners.map((owner:any)=>[owner.key,owner]));
    for(const [key,owner] of rows)if((versions.get(key)||0)>startedEpoch)next.set(key,owner);
    rows=next;observed=true;failed=false;
   }catch{ failed=true; /* Keep the last successful owner view and its metadata revision. */ }
   finally{nextRefreshAt=Date.now()+TTL_MS;flight=undefined;}
  })();
 }
 return {rows,state:observed?(flight?'refreshing':failed?'stale':'observed'):'pending'};
}
