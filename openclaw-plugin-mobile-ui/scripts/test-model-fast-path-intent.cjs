const serviceScope={schema_version:'mcp-service.v1',domain_id:'pulse'};
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {INTENT_INPUT_PROTOCOL,runModelFastPath}=require('../dist/modelFastPath.js');
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'intent-input-'));
 const previous=process.env.SAMANTHA_INTENT_INTERPRETER;
 try{
  assert.equal(INTENT_INPUT_PROTOCOL,'mcp-input.v1');
  const helper=path.join(tmp,'helper.py');
  fs.writeFileSync(helper,`import os,sys,json\npayload=json.load(sys.stdin)\nassert os.environ.get('SAMANTHA_INTENT_INPUT_FD')=='0'\nassert '--intent-context-stdin' in sys.argv\nassert payload['request'] not in sys.argv\nprint(json.dumps({'status':'known_error','reason':'DATA_PROFILE_UNVERIFIED','intentInputProtocol':'mcp-input.v1','text':payload['request']}))\n`);
  const text='  Exact original\nmessage  ';
  const input={request:text,service_scope:serviceScope,client_context:{schema_version:'mcp-input.v1',original_message:{text},conversation_ref:'thread'}};
  const bridge=require('../dist/companion/remoteBridge');
  const admission={type:'mcp_request',clientId:'fixture',profile:'chat-owner',requestId:'fixture-request',interpretationService:serviceScope};
  bridge.registerAuthenticatedMcpRelayMessage(admission);
  const options={helperPath:helper,surface:'mcp',caller:'owner',requestId:'fixture-request',originId:'fixture-request',intentContextAdmission:admission,dialogue:{mode:'preview',event:{conversationKey:'external_mcp:fixture:thread',eventRef:'fixture-request'}},intentContext:input};
  process.env.SAMANTHA_INTENT_INTERPRETER='1';
  const result=await runModelFastPath(text,options);
  assert.equal(result.text,text);assert.equal(result.reason,'DATA_PROFILE_UNVERIFIED');
  for(const change of [{surface:'app'},{qaContext:{}},{dialogue:undefined},{intentContext:{...input,request:'different'}}]){
   assert.equal((await runModelFastPath(text,{...options,...change})).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  }
  process.env.SAMANTHA_INTENT_INTERPRETER='0';
  assert.equal((await runModelFastPath(text,options)).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  process.env.SAMANTHA_INTENT_INTERPRETER='1';
  const old=path.join(tmp,'old.py');
  fs.writeFileSync(old,`import json\nprint(json.dumps({'status':'hit','text':'legacy output'}))\n`);
  assert.equal((await runModelFastPath(text,{...options,helperPath:old})).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  const oversize={request:text,service_scope:serviceScope,client_context:{...input.client_context,payload:'x'.repeat(32768)}};
  assert.equal((await runModelFastPath(text,{...options,intentContext:oversize})).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  console.log('Intent host private transport: 10/10 assertions passed; no model or runtime effect.');
 }finally{
  if(previous===undefined)delete process.env.SAMANTHA_INTENT_INTERPRETER;else process.env.SAMANTHA_INTENT_INTERPRETER=previous;
  fs.rmSync(tmp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
