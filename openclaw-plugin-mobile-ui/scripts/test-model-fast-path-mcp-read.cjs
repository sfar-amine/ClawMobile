const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {INTENT_READ_PROTOCOL,runModelFastPath}=require('../dist/modelFastPath.js');
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'intent-mcp-read-'));
 const previous=process.env.SAMANTHA_INTENT_INTERPRETER;
 try{
  process.env.SAMANTHA_INTENT_INTERPRETER='1';
  assert.equal(INTENT_READ_PROTOCOL,'mcp-read.v1');
  const helper=path.join(tmp,'helper.py');
  fs.writeFileSync(helper,`import json,sys\npayload=json.load(sys.stdin)\nassert '--intent-read-only' in sys.argv\nassert '--intent-context-stdin' in sys.argv\nprint(json.dumps({'status':'hit','execution_state':'completed','result':{'fixture':True},'intentInputProtocol':'mcp-input.v1','intentReadProtocol':'mcp-read.v1'}))\n`);
  const text='  Read exact  ';
  const input={request:text,client_context:{schema_version:'mcp-input.v1',original_message:{text}}};
  const options={helperPath:helper,surface:'mcp',caller:'owner',dialogue:{mode:'preview',event:{conversationKey:'external_mcp:client:thread',eventRef:'canonical-request'}},intentContext:input,intentReadOnly:true};
  const result=await runModelFastPath(text,options);
  assert.equal(result.status,'hit');assert.equal(result.intentReadProtocol,'mcp-read.v1');
  assert.equal((await runModelFastPath(text,{...options,intentContext:undefined})).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  assert.equal((await runModelFastPath(text,{...options,dialogue:{mode:'turn'}})).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  const partial=path.join(tmp,'partial.py');
  fs.writeFileSync(partial,`import json\nprint(json.dumps({'status':'hit','execution_state':'completed','intentInputProtocol':'mcp-input.v1'}))\n`);
  assert.equal((await runModelFastPath(text,{...options,helperPath:partial})).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  const failing=path.join(tmp,'failing.py');
  fs.writeFileSync(failing,`import json,sys\nprint(json.dumps({'status':'hit','intentInputProtocol':'mcp-input.v1'}))\nsys.exit(1)\n`);
  assert.equal((await runModelFastPath(text,{...options,helperPath:failing})).reason,'INTERPRETATION_HOST_UNAVAILABLE');
  const legacy=path.join(tmp,'legacy.py');
  fs.writeFileSync(legacy,`import json,os,sys\nassert 'SAMANTHA_INTENT_INTERPRETER' not in os.environ\nassert 'SAMANTHA_INTENT_INPUT_FD' not in os.environ\nprint(json.dumps({'status':'miss','text':sys.argv[-1]}))\n`);
  for(const surface of ['app','whatsapp'])for(const original of ['état de mon forfait Orange','paiement demandé, fixture sans exécution']){
    const historical=await runModelFastPath(original,{helperPath:legacy,surface,checkOnly:true});
    assert.equal(historical.status,'miss');assert.equal(historical.text,original);
  }
  const previousRoot=process.env.CLAW_UI_PLAYBOOKS_ROOT;
  try{
    process.env.CLAW_UI_PLAYBOOKS_ROOT=path.join(tmp,'missing-playbooks');
    const real=await runModelFastPath(text,{...options,helperPath:path.resolve(__dirname,'../../installer/termux-lite/model-fast-path.py')});
    assert.equal(real.intentInputProtocol,'mcp-input.v1');
    assert.equal(real.intentReadProtocol,'mcp-read.v1');
    assert.equal(real.reason,'INTERPRETATION_HOST_UNAVAILABLE');
  }finally{if(previousRoot===undefined)delete process.env.CLAW_UI_PLAYBOOKS_ROOT;else process.env.CLAW_UI_PLAYBOOKS_ROOT=previousRoot;}
  console.log('MCP read host port and bounded pilot: 18/18 assertions passed; no model, network or real read.');
 }finally{
  if(previous===undefined)delete process.env.SAMANTHA_INTENT_INTERPRETER;else process.env.SAMANTHA_INTENT_INTERPRETER=previous;
  fs.rmSync(tmp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
