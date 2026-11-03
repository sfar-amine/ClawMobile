// Real admission owners with synthetic frames; no model/private source/effect.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-service-scope-'));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR=path.join(folder,'bridge');
process.env.SAMANTHA_INTENT_INTERPRETER='1';
const host=require('../dist/modelFastPath');
host.INTENT_INPUT_PROTOCOL='mcp-input.v1';host.INTENT_READ_PROTOCOL='mcp-read.v1';
let calls=0;
host.runModelFastPath=async()=>{calls++;return {intentInputProtocol:'mcp-input.v1',status:'known_error',reason:'DATA_PROFILE_UNVERIFIED'};};
const bridge=require('../dist/companion/remoteBridge');
const mcp=require('../dist/companion/mcpBridge');
const scope={schema_version:'mcp-service.v1',domain_id:'pulse'};
const text='A request with no lexical scope selection';
const context={schema_version:'mcp-input.v1',original_message:{text,ref:'event'},conversation_ref:'thread',local_revision:0,relevant_turns:[],entity_references:[],active_goal_ref:null,pending_question_ref:null,confirmation_ref:null,user_reply_ref:null,completeness:'complete',missing:[]};
function frame(){return {type:'mcp_request',requestId:'mcp-scope-preview',clientId:'scope-owner',profile:'chat-owner',tool:'claw_resolve',interpretationService:{...scope},arguments:{request:text,client_context:context,service_scope:{...scope}}};}
let n=0;const check=(v,why)=>{assert.ok(v,why);n++;};
(async()=>{try{
 for(const bad of [undefined,null,true,{},['pulse'],{...scope,domain_id:'orange'},{...scope,schema_version:'future'},{...scope,verified:true}]){
  const value=frame();value.arguments.service_scope=bad;bridge.registerAuthenticatedMcpRelayMessage(value);
  check((await mcp.handleMcpRelayRequest(value)).reason==='MCP_INTERPRETATION_SERVICE_REQUIRED','invalid selector stops before bootstrap');
 }
 for(const value of [frame(),{...frame(),interpretationService:undefined}]){
  if(value.interpretationService===undefined)bridge.registerAuthenticatedMcpRelayMessage(value);
  check((await mcp.handleMcpRelayRequest(value)).reason==='MCP_INTERPRETATION_SERVICE_UNVERIFIED','selector or owner JSON alone is not admission');
 }
 const admitted=frame();bridge.registerAuthenticatedMcpRelayMessage(admitted);
 check((await mcp.handleMcpRelayRequest({...admitted})).reason==='MCP_INTERPRETATION_SERVICE_UNVERIFIED','a copied JSON frame loses host admission');
 admitted.interpretationService={...scope,domain_id:'orange'};
 check((await mcp.handleMcpRelayRequest(admitted)).reason==='MCP_INTERPRETATION_SERVICE_UNVERIFIED','changed binding loses scope');
 const late=frame();bridge.registerAuthenticatedMcpRelayMessage(late);
 const info=bridge.authenticatedMcpContextMetadata(late),clock=Date.now;
 try{Date.now=()=>info.valid_until*1000;check((await mcp.handleMcpRelayRequest(late)).reason==='MCP_INTERPRETATION_SERVICE_UNVERIFIED','expired owner binding stops before bootstrap');}finally{Date.now=clock;}
 const shadow=frame();shadow.profile='chat-owner-shadow';bridge.registerAuthenticatedMcpRelayMessage(shadow);
 check((await mcp.handleMcpRelayRequest(shadow)).reason==='MCP_INTERPRETATION_SERVICE_UNVERIFIED','shadow cannot upgrade its catalogue/private reader by scope');
 const missingContext=frame();delete missingContext.arguments.client_context;bridge.registerAuthenticatedMcpRelayMessage(missingContext);
 check((await mcp.handleMcpRelayRequest(missingContext)).reason==='client_context_required_for_service_scope','an isolated service selector is not ignored by legacy');
 check(calls===0,'all refusals precede every helper/model call');
 const good=frame();bridge.registerAuthenticatedMcpRelayMessage(good);
 const out=await mcp.handleMcpRelayRequest(good);
 check(calls===1&&out.result.reason==='DATA_PROFILE_UNVERIFIED','valid scope never fabricates DATA permission or falls through lexically');
 check(Object.keys(bridge.authenticatedMcpContextMetadata(good).service_scope).sort().join(',')==='domain_id,schema_version','host scope contains no DATA class or permission');
 check(!fs.existsSync(path.join(folder,'bridge','requests')),'preview/refusals create no durable effect receipt');
 console.log(`MCP service scope: ${n}/${n} checks; MOCK_ONLY, provider calls 0, real effects 0`);
}finally{fs.rmSync(folder,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
