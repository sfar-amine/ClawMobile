const serviceScope={schema_version:'mcp-service.v1',domain_id:'pulse'};
// Immutable paired repository fixture: actual owners, Recorded/MOCK inference, no provider or business effect.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const core=path.resolve(__dirname,'../..');
const pb=path.resolve(process.argv[2]||'');
const expected=process.argv[3];
assert.match(expected||'',/^[a-f0-9]{40}$/,'usage: node test-mcp-context-paired.cjs <playbooks-root> <exact-pb-sha> [result.json]');
const pbSha=execFileSync('git',['-C',pb,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(pbSha,expected,'paired playbooks must match the immutable dependency');
const coreSha=execFileSync('git',['-C',core,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const outputPath=process.argv[4]?path.resolve(process.argv[4]):null;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'c12-real-pair-'));
Object.assign(process.env,{CLAWMOBILE_REMOTE_BRIDGE_DIR:path.join(root,'bridge'),CLAW_DIALOGUE_HOME:path.join(root,'dialogue'),CLAW_UI_PLAYBOOKS_ROOT:pb,SAMANTHA_INTENT_INTERPRETER:'1',CLAW_SERVICE_NOW:'1791882000',PAIR_ROOT:root,MCP_PAIRED_PLAYBOOKS_ROOT:pb});
const host=require(core+'/openclaw-plugin-mobile-ui/dist/modelFastPath');
const bridge=require(core+'/openclaw-plugin-mobile-ui/dist/companion/remoteBridge');
const actual=host.runModelFastPath;let helperCalls=0;
host.runModelFastPath=async(text,options)=>{
 helperCalls++;if(options.intentReadOnly)assert.equal(bridge.getRemoteBridgeRequest(options.requestId).state,'running','canonical Node claim exists BEFORE Python generation');
 return actual(text,{...options,helperPath:path.join(__dirname,'fixtures/mcp-context-paired-helper.py')});
};
const mcp=require(core+'/openclaw-plugin-mobile-ui/dist/companion/mcpBridge');
const context=(thread,text)=>({schema_version:'mcp-input.v1',original_message:{text,ref:'current'},conversation_ref:thread,local_revision:0,relevant_turns:[],entity_references:[],active_goal_ref:null,pending_question_ref:null,confirmation_ref:null,user_reply_ref:null,completeness:'complete',missing:[]});
const invoke=(action,thread,text,admit=true,profile='chat-owner')=>{
 const frame={type:'mcp_request',interpretationService:serviceScope,requestId:'mcp-claude-chat-'+action+'-execute',clientId:'claude-chat',profile,tool:'claw_execute',arguments:{request:text,service_scope:serviceScope,client_context:context(thread,text),action_key:action}};
 if(admit)bridge.registerAuthenticatedMcpRelayMessage(frame);
 return mcp.handleMcpRelayRequest(frame);
};
const rows=()=>fs.existsSync(path.join(root,'audit.jsonl'))?fs.readFileSync(path.join(root,'audit.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
(async()=>{
 try{
  // ADR 02/11 « le cerveau partout », step 3 (S24: SAMANTHA_BRAIN_ONLY=1 since 28/10, now unconditional): the owner's
  // MCP free text is never interpreted before the brain. The read is refused by the actual owners after the canonical
  // Node claim, before any interpretation, private source or business executor. Typed MCP selection replaces it (step 7).
  const text='  Lis huwaei\n';
  const forged=await invoke('unadmitted','forged',text,false);
  assert.equal(forged.state,'failed');assert.equal(forged.reason,'MCP_INTERPRETATION_SERVICE_UNVERIFIED',JSON.stringify(forged));
  assert.equal(rows().length,0,'public owner JSON does not open private sources');
  const shadow=await invoke('shadow','shadow',text,true,'chat-owner-shadow');assert.notEqual(shadow.state,'completed');
  assert.equal(rows().length,0,'shadow does not open private sources');
  const first=await invoke('pair-one','thread-one',text);
  assert.equal(first.state,'failed',JSON.stringify(first));assert.equal(first.reason,'INTERPRETATION_HOST_UNAVAILABLE',JSON.stringify(first));
  const replay=await invoke('pair-one','thread-one',text);
  assert.equal(replay.state,'failed');assert.equal(helperCalls,1,'one canonical claim, no second Python call on replay');
  const write=await invoke('pair-write','thread-write','démarre le projet huwaei');assert.equal(write.state,'failed');
  const log=rows();
  assert.equal(log.filter(row=>row.kind==='interpretation').length,0,'no owner interpretation');
  assert.equal(log.filter(row=>row.kind==='executor').length,0,'no business executor');
  const output={core_sha:coreSha,playbooks_sha:pbSha,qualification:'MOCK_ONLY',external_provider_calls:0,real_business_effects:0,canonical_claim_before_generation:true,helper_calls:helperCalls,
   owner_free_text_reads:0,owner_free_text_reason:first.reason,interpretations:0,executor_calls:0};
  if(outputPath)fs.writeFileSync(outputPath,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
