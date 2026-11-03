// deploy-parcours.py, room paths (Amine 02/11): the Pulse room brain of the test contact « Recette Pulse »
// (fictitious +216 10 000 001, added by Amine with his biometrics on 29/10, routed to contacts-projet-pulse), through
// what the Gateway has loaded: the deployed room tool factory, the before_tool_call proof, the real room grant read
// (people-trusted) and the real typed helper (playbooks room owner). The model's choice is replaced by one fixed typed
// call per path. Nothing is sent on WhatsApp. Prints one JSON line {reply, state, reasonCode, facts, seconds, error}.
//
//   tool <action> <params-json>   the room tool itself (reads and refusals only, see deploy-parcours.py ROOM_CALLS)
//   prepare <action> <params-json>  a write: the room owner's `call` only, then `abort` of its prepared hand-off.
//                                 The room owner never writes in `call` (every room write stops at its hand-off) and
//                                 this runner never sends `handoff`: no Pulse write is possible here.
//   prepare-first-project <params-json>  same, on the first project of the contact's own project list (read)
//   generic-tools                the room tools the deployed factory gives a generic room session (agenda, actions,
//                                messages) of the same contact: names only, no grant read, nothing run
//   generic-outside              that session's agenda tool asked another domain's action: refused before any read
//   generic-read                 a read in a generic room of the same contact. Granted such a room: its routed agent
//                                reads (device status, or tomorrow's agenda); otherwise the deployed room tool must
//                                refuse on the real grant read with no typed helper call. Reads only, never a write.
'use strict';
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const [,,mode,action,paramsJson]=process.argv;
const E164='+21610000001',AGENT='contacts-projet-pulse',SESSION=`agent:${AGENT}:whatsapp:direct:${E164}`;
const TOOL_ACTIONS=new Set(['project.search','leave.balance','leave.request','agenda.read']);
// Amine 02/11, contact rooms brain: the generic room session of the recette contact (combined agenda/actions/messages).
const GENERIC_AGENT='contacts-agenda-actions-messages',GENERIC_SESSION=`agent:${GENERIC_AGENT}:whatsapp:direct:${E164}`;
const GENERIC_MODES=new Set(['generic-tools','generic-outside','generic-read']);
const WRITE_ACTIONS=new Set(['project.create','project.phase.set_status']);
function gatewayEnv(){
  // The helpers run as inside the Gateway: run them with the Gateway's environment.
  const pid=execFileSync('pgrep',['-f','openclaw-gateway'],{encoding:'utf8'}).trim().split('\n')[0];
  for(const line of fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0')){
    const i=line.indexOf('=');if(i>0&&!(line.slice(0,i) in process.env))process.env[line.slice(0,i)]=line.slice(i+1);
  }
}
function params(raw){
  const value=JSON.parse(raw||'{}');
  if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>500)throw Error('usage');
  return value;
}
(async()=>{
  const began=Date.now();let out={reply:'',state:'',reasonCode:'',facts:false,error:null};
  try{
    const tool=mode==='tool',first=mode==='prepare-first-project';
    if(!(tool&&TOOL_ACTIONS.has(action)||mode==='prepare'&&WRITE_ACTIONS.has(action)||first||GENERIC_MODES.has(mode)))throw Error('usage');
    gatewayEnv();
    const dist=path.join(process.env.HOME,'.openclaw/extensions/openclaw-plugin-mobile-ui/dist');
    const brain=require(path.join(dist,'roomBrain'));
    const run='recette-'+Date.now();
    if(GENERIC_MODES.has(mode)){
      const {agentCapabilityHook}=require(path.join(dist,'capabilityAgentGuard'));
      const {allowlistRead}=require(path.join(dist,'companion/whatsappAllowlist'));
      const {roomAgentFor}=require(path.join(dist,'contactRoomProfile'));
      let agent=GENERIC_AGENT,session=GENERIC_SESSION,granted=false,helperCalls=0;
      let name='samantha_agenda',args={action:'project.search',params:{}};
      if(mode==='generic-read'){
        // The contact's real grant decides which session reads; the room tool reads it again itself.
        const grant=await allowlistRead('get','wa-'+require('crypto').createHash('sha256').update(E164).digest('hex').slice(0,16));
        const routed=roomAgentFor(grant?.success===true&&grant.state==='active'?grant.rooms:null);
        const rooms=routed?routed.split('-').slice(1):[];
        if(rooms.includes('actions')||rooms.includes('agenda')){granted=true;agent=routed;session=`agent:${agent}:whatsapp:direct:${E164}`;}
        const day=new Date(Date.now()+86400000).toISOString().slice(0,10);
        [name,args]=granted&&!rooms.includes('actions')
          ?['samantha_agenda',{action:'agenda.event.read',params:{calendar_id:'primary',time_min:`${day}T00:00:00+01:00`,time_max:`${day}T23:59:59+01:00`}}]
          :['samantha_device_assistance',{action:'device.status.read',params:{}}];
      }
      const ctx={agentId:agent,sessionKey:session,sessionId:run,senderIsOwner:false,messageChannel:'whatsapp',assertInvocationCurrent(){}};
      const helper=brain.roomTypedHelper();
      const tools=brain.createRoomTools(ctx,{runTyped:input=>{helperCalls++;return helper(input);}})||[];
      if(mode==='generic-tools'){
        out={reply:'',state:'TOOLS',reasonCode:tools.map(t=>t.name).join(','),facts:false,error:null};
        throw Object.assign(Error('done'),{done:true});
      }
      const room=tools.find(t=>t.name===name);
      if(!room)throw Error('room_tool_unavailable');
      const call=run+'-1';
      const proof=agentCapabilityHook({toolName:name,params:args,toolCallId:call},
        {requester:{senderIsOwner:false},agentId:agent,runId:run,sessionKey:session,sessionId:run});
      if(proof?.block)throw Error('room_proof_refused');
      const result=await room.execute(call,args);
      const body=JSON.parse(result.content[0].text);
      out={reply:String(result.details?.sourceReply?.text||''),state:String(body.state||''),reasonCode:String(body.reasonCode||''),
        facts:!!(body.facts&&Object.keys(body.facts).length),granted,helperCalls,error:null};
    }else if(tool){
      const args={action,params:params(paramsJson)},call=run+'-1';
      const ctx={agentId:AGENT,sessionKey:SESSION,sessionId:run,senderIsOwner:false,messageChannel:'whatsapp',assertInvocationCurrent(){}};
      const tools=brain.createRoomTools(ctx);
      if(!tools)throw Error('room_tool_unavailable');
      const {agentCapabilityHook}=require(path.join(dist,'capabilityAgentGuard'));
      const proof=agentCapabilityHook({toolName:tools[0].name,params:args,toolCallId:call},
        {requester:{senderIsOwner:false},agentId:AGENT,runId:run,sessionKey:SESSION,sessionId:run});
      if(proof?.block)throw Error('room_proof_refused');
      const result=await tools[0].execute(call,args);
      const body=JSON.parse(result.content[0].text);
      out={reply:String(result.details?.sourceReply?.text||''),state:String(body.state||''),reasonCode:String(body.reasonCode||''),
        facts:!!(body.facts&&Object.keys(body.facts).length),error:null};
    }else{
      const {pulseRoomSession}=require(path.join(dist,'contactRoomProfile'));
      const {roomGrantPacket}=brain;
      const {allowlistRead}=require(path.join(dist,'companion/whatsappAllowlist'));
      const room=pulseRoomSession(AGENT,SESSION),typed=brain.roomTypedHelper();
      const once=async(call,command,grant)=>typed(JSON.stringify({command,host:brain.roomHost(room,run,call),
        roomAdmission:roomGrantPacket(room,run+':'+call,grant)}));
      const grant=await allowlistRead('get',room.contactId);
      let target=action,given=first?{}:params(paramsJson);
      if(first){
        // The contact's own project list, read through the room owner; its first project is the dry-run target.
        const list=await once('list',{operation:'call',domain:'pulse',action:'project.search',params:{}},grant);
        const id=list?.facts?.projects?.[0]?.project_id;
        if(list?.state!=='COMPLETED'||!/^\d{1,12}$/.test(String(id??''))){
          out={reply:String(list?.answer||''),state:String(list?.state||''),reasonCode:'recette_no_project',facts:false,error:null};
          throw Object.assign(Error('done'),{done:true});
        }
        target='project.phase.set_status';given={...params(action),project_query:String(id)};
      }
      const result=await once('write',{operation:'call',domain:'pulse',action:target,params:given},grant);
      const goalRef=result?.prepared?.goalRef;
      if(goalRef){
        // Grant re-read as before a real hand-off, then the prepared write is closed without any effect.
        const fresh=await allowlistRead('get',room.contactId);
        const closed=await once('write',{operation:'abort',domain:'pulse',goalRef,reason:'stopped_before_effect'},fresh);
        out={reply:String(result.answer||''),state:'PREPARED',reasonCode:String(closed?.state||''),facts:false,error:null};
      }else out={reply:String(result?.answer||''),state:String(result?.state||''),reasonCode:String(result?.reasonCode||''),
        facts:!!(result?.facts&&Object.keys(result.facts).length),error:null};
    }
  }catch(e){if(!e?.done)out.error=String(e&&e.message||e).slice(0,120);}
  console.log(JSON.stringify({...out,seconds:(Date.now()-began)/1000}));
  process.exit(0);
})();
