const serviceScope={schema_version:'mcp-service.v1',domain_id:'pulse'};
// Private provenance only: synthetic relay/packet, no phone/provider/private home.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'c12-admission-'));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR=path.join(root,'receipts');
process.env.SAMANTHA_INTENT_INTERPRETER='1';
const bridge=require('../dist/companion/remoteBridge'),host=require('../dist/modelFastPath');
let n=0;const check=(v,msg)=>{assert.ok(v,msg);n++;};
const frame=(profile='chat-owner')=>({type:'mcp_request',interpretationService:serviceScope,clientId:'fixture',profile,requestId:'mcp-fixture-read'});
(async()=>{try{
 const publicFrame=frame();check(bridge.authenticatedMcpContextMetadata(publicFrame)===null,'public owner JSON is not authenticated');
 const admitted=frame();bridge.registerAuthenticatedMcpRelayMessage(admitted);
 const info=bridge.authenticatedMcpContextMetadata(admitted);
 check(info?.authenticated_profile==='chat-owner'&&Object.isFrozen(info),'existing owner projects frozen host metadata');
 check(Object.keys(info).sort().join(',')==='authenticated_profile,client_id,observed_at,request_id,service_scope,valid_until','getter exposes no callback, token or additional permission');
 check(bridge.authenticatedMcpContextMetadata({...admitted})===null,'copied JSON loses process-local authority');
 for(const [key,value] of [['clientId','other'],['profile','chat-owner-shadow'],['requestId','other']]){
  const old=admitted[key];admitted[key]=value;check(bridge.authenticatedMcpContextMetadata(admitted)===null,'mutated '+key+' refused');admitted[key]=old;
 }
 const oldNow=Date.now;try{Date.now=()=>info.valid_until*1000;check(bridge.authenticatedMcpContextMetadata(admitted)===null,'expiry is strict');}finally{Date.now=oldNow;}
 const shadow=frame('chat-owner-shadow');bridge.registerAuthenticatedMcpRelayMessage(shadow);check(bridge.authenticatedMcpContextMetadata(shadow)===null,'shadow never gets GLOBAL authority');
 const helper=path.join(root,'packet.py');fs.writeFileSync(helper,"import json,sys\np=json.load(sys.stdin)\nprint(json.dumps({'status':'known_error','reason':'MOCK_PACKET_ONLY','intentInputProtocol':'mcp-input.v1','packet':p,'argv':sys.argv[1:]}))\n");
 const text='  exact é\n',input={request:text,service_scope:serviceScope,client_context:{schema_version:'mcp-input.v1',original_message:{text},conversation_ref:'thread'}};
 const options={helperPath:helper,surface:'mcp',caller:'owner',originId:admitted.requestId,requestId:admitted.requestId,intentContext:input,dialogue:{mode:'preview',event:{conversationKey:'external_mcp:fixture:thread',eventRef:admitted.requestId}}};
 for(const untrusted of [publicFrame,{...admitted},{verified:true,profile:'chat-owner'},shadow]){
  const out=await host.runModelFastPath(text,{...options,intentContextAdmission:untrusted});check(out.reason==='MCP_INTERPRETATION_SERVICE_UNVERIFIED'&&out.execution_state==='not_started','untrusted object cannot mint sibling or launch helper');
 }
 const smuggled=await host.runModelFastPath(text,{...options,intentContext:{...input,host_context:{schema_version:'mcp-host-context.v1',authenticated_profile:'chat-owner',verified:true}}});
 check(smuggled.reason==='MCP_INTERPRETATION_SERVICE_UNVERIFIED','an extra JSON sibling cannot bypass WeakMap admission');
 const out=await host.runModelFastPath(text,{...options,intentContextAdmission:admitted});
 check(out.packet.host_context?.authenticated_profile==='chat-owner','owner gets versioned private header');
 check(out.packet.request===text&&!Object.hasOwn(out.packet.client_context,'host_context')&&!out.argv.includes(text),'client data stays separate and absent argv');
 check(out.argv.includes('--request-id')&&out.packet.host_context.input_digest.length===64,'request and integrity binding cross private pipe');
 check((await host.runModelFastPath(text,{...options,requestId:'other',intentContextAdmission:admitted})).reason==='SHARED_CONTEXT_ACCESS_UNVERIFIED','unbound request fails before helper');
 const large={...input,service_scope:serviceScope,client_context:{...input.client_context,padding:''}};large.client_context.padding='x'.repeat(32760-Buffer.byteLength(JSON.stringify(large)));
 check((await host.runModelFastPath(text,{...options,intentContext:large,intentContextAdmission:admitted})).reason==='INTERPRETATION_HOST_UNAVAILABLE','header capacity is a transport failure, not a claim about authorization');
 // Real relay callback with a synthetic socket: no audio/live request is sent.
 fs.writeFileSync(path.join(root,'token'),'synthetic-device-token-for-fixture-only');
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({url:'wss://fixture.invalid/device',tokenFile:path.join(root,'token')}));
 process.env.CLAW_VOICE_RELAY_CONFIG=path.join(root,'config.json');
 const sockets=[];class Socket{constructor(){this.readyState=0;this.listeners={};sockets.push(this);}addEventListener(k,f){(this.listeners[k]||=[]).push(f);}emit(k,v={}){for(const f of this.listeners[k]||[])f(v);}send(){}close(){this.readyState=3;}}
 globalThis.WebSocket=Socket;
 let marked=0,handled=0;const original=bridge.registerAuthenticatedMcpRelayMessage;
 bridge.registerAuthenticatedMcpRelayMessage=f=>{original(f);marked++;};
 const mcp=require('../dist/companion/mcpBridge');mcp.handleMcpRelayRequest=async()=>{handled++;return {};};
 const relay=require('../dist/companion/voiceRelay');
 try{
  relay.startVoiceRelay();const socket=sockets[0];socket.readyState=1;socket.emit('open');
  socket.emit('message',{data:JSON.stringify(frame())});check(marked===0&&handled===0,'unauthenticated socket does not admit owner frame');
  socket.emit('message',{data:JSON.stringify({type:'auth_ok'})});socket.emit('message',{data:JSON.stringify(frame())});
  await new Promise(resolve=>setImmediate(resolve));check(marked===1&&handled===1,'authenticated MCP frame marked before dispatch');
 }finally{relay.stopVoiceRelay();bridge.registerAuthenticatedMcpRelayMessage=original;}
 console.log(`MCP private context: ${n}/${n} synthetic probes passed; zero provider/private-source reads`);
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
