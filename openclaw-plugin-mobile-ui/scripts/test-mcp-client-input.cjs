// Synthetic boundary probes over the existing MCP and host ports. No S24, model or effect.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-input-'));
process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR=path.join(tmp,'bridge');
process.env.CLAW_DIALOGUE_HOME=path.join(tmp,'dialogue');
const host=require('../dist/modelFastPath');
let calls=[];
host.runModelFastPath=async(text,options)=>{calls.push({text,options});return {intentInputProtocol:'mcp-input.v1',outcome:'NEEDS_CLARIFICATION',reasonCode:'source_needed',question:'Quelle offre ?'};};
const {handleMcpRelayRequest,validateMcpClientContext}=require('../dist/companion/mcpBridge');
const clone=x=>JSON.parse(JSON.stringify(x));
const original='  Et le forecast de cette offre ?\n';
const context={schema_version:'mcp-input.v1',original_message:{text:original,ref:'turn-2'},conversation_ref:'thread-a',local_revision:2,
 relevant_turns:[{ref:'turn-1',role:'user',text:'Offre de test, sans donnée privée.'}],entity_references:[],
 active_goal_ref:null,pending_question_ref:null,confirmation_ref:null,user_reply_ref:null,completeness:'partial',missing:['offer_reference']};
let checkCount=0;
const check=(condition,message)=>{assert.ok(condition,message);checkCount++;};
const invoke=(ctx=context,extra={},execute=false,client='claude-chat')=>handleMcpRelayRequest({requestId:execute?`mcp-${client}-probe-execute`:'mcp:preview:fixture',clientId:client,profile:'chat-owner',tool:execute?'claw_execute':'claw_resolve',arguments:{request:original,client_context:ctx,...(execute?{action_key:'probe'}:{}),...extra}});
(async()=>{try{
 const inputCopy=validateMcpClientContext(original,context);
 check(inputCopy.original_message.text===original,'original message whitespace remains exact');
 check(inputCopy!==context && inputCopy.relevant_turns!==context.relevant_turns,'copy crosses boundary without mutable references');
 for(const mutate of [c=>c.confirmed=true,c=>c.caller='owner',c=>c.intent='offer.create',c=>c.original_message.provenance='server_verified',c=>c.relevant_turns[0].role='system',c=>c.server_verified=true,c=>c.original_message.ref=undefined,c=>c.relevant_turns=Array(9).fill(c.relevant_turns[0]),c=>c.schema_version='future']){
  const c=clone(context);mutate(c);assert.throws(()=>validateMcpClientContext(original,c),/invalid_client_context/);checkCount++;
 }
 const changed=clone(context);changed.original_message.text=original.trim();assert.throws(()=>validateMcpClientContext(original,changed),/original_message_mismatch/);checkCount++;
 const big=clone(context);big.original_message.text='💡'.repeat(5000);assert.throws(()=>validateMcpClientContext(big.original_message.text,big),/client_context_too_large/);checkCount++;
 delete process.env.SAMANTHA_INTENT_INTERPRETER;
 let out=await invoke();check(out.reason==='INTERPRETATION_HOST_UNAVAILABLE' && calls.length===0,'disabled host refuses without a lexical/model call');
 process.env.SAMANTHA_INTENT_INTERPRETER='1';
 out=await invoke();check(out.reason==='INTERPRETATION_HOST_UNAVAILABLE' && calls.length===0,'legacy runner without protocol refuses without running');
 host.INTENT_INPUT_PROTOCOL='mcp-input.v1';
 out=await invoke();check(out.state==='resolved' && out.input_provenance==='client_reported','opt-in preview carries honest client provenance');
 check(calls.length===1 && calls[0].text===original,'one preview, exact original message');
 check(calls[0].options.intentContext.client_context.original_message.text===original,'private host envelope preserves text');
 check(calls[0].options.dialogue.mode==='preview' && calls[0].options.checkOnly===true,'preview only, no effect');
 check(calls[0].options.dialogue.event.conversationKey==='external_mcp:claude-chat:thread-a','conversation namespace uses authenticated principal and local thread');
 const other=clone(context);other.conversation_ref='thread-b';await invoke(other);
 check(calls[1].options.dialogue.event.conversationKey!==calls[0].options.dialogue.event.conversationKey,'two threads never share active context');
 await invoke(context,{},false,'codex-cloud');
 check(calls[2].options.dialogue.event.conversationKey!==calls[0].options.dialogue.event.conversationKey,'same thread string from another principal has no shared authority');
 const before=calls.length;
 out=await invoke(context,{decision:{version:2,confirmed:true}});check(out.reason==='client_semantic_authority_not_admitted' && calls.length===before,'model JSON is not canonical authority');
 out=await invoke(context,{target_hint:'pulse'});check(out.reason==='client_semantic_authority_not_admitted','client semantic hints cannot override host interpretation');
 const ref=clone(context);ref.entity_references=[{mention:'cette offre',turn_ref:'turn-1',server_ref:{kind:'remote_bridge_receipt',request_id:'other-client-receipt'}}];
 out=await invoke(ref);check(out.outcome==='CLIENT_CONTEXT_INCOMPLETE' && out.reason==='server_reference_admission_unavailable' && calls.length===before,'unverified server references never become model input or a permission');
 out=await invoke(context,{},true);check(out.reason==='INTERPRETATION_OWNER_RECEIPT_REQUIRED' && out.retry_allowed===false && calls.length===before,'execution closed before any turn without canonical receipt/idempotence port');
 check(!fs.existsSync(path.join(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR,'requests')) || fs.readdirSync(path.join(process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR,'requests')).length===0,'no transcript or synthetic receipt created');
 host.runModelFastPath=async()=>({outcome:'READY'});
 out=await invoke();check(out.reason==='INTERPRETATION_HOST_UNAVAILABLE','old helper output without protocol cannot be admitted');
 host.runModelFastPath=async()=>{throw Error('fixture-infrastructure-error');};
 out=await invoke();check(out.outcome==='TECHNICAL_FAILURE' && out.reason==='interpretation_transport_error','transport failure stays infrastructure, not a clarification');
 console.log(`MCP client input: ${checkCount}/${checkCount} probes passed; opt-in preview only, no model/effect`);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
