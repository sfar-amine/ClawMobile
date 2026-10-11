const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
async function main(){
 const {createCapabilityTool,clawmobile_capability}=require('../dist/capabilityTool.js');
 const protocol=fs.readFileSync(path.join(__dirname,'../fixtures/protocol/openclaw-2026.9.6/tool-context-excerpts.d.ts'),'utf8');
 assert.match(protocol,/senderIsOwner\?: boolean/);assert.match(protocol,/\(ctx: OpenClawPluginToolContext\)/);
 const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/r17/inbound-schema.json'),'utf8'));
 const ownerBit=capture.sampleRows.find(x=>x.transcript_events?.event_json?.message?.__openclaw?.senderIsOwner===true).transcript_events.event_json.message.__openclaw.senderIsOwner;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'capability-admission-'));
 try {
  const helper=path.join(root,'helper.py'), effects=path.join(root,'calls');
  fs.writeFileSync(helper,`import json,sys\nfrom pathlib import Path\np=Path(${JSON.stringify(effects)})\nwith p.open('a') as f: f.write(sys.argv[1]+'\\n')\nprint(json.dumps({'caller':sys.argv[sys.argv.index('--caller')+1],'execution':{'state':'completed'}}))\n`);
  const count=()=>fs.existsSync(effects)?fs.readFileSync(effects,'utf8').trim().split('\n').length:0;
  const execute=async(ctx,args)=>JSON.parse((await createCapabilityTool(ctx,{helperPath:helper}).execute('call-id',args)).content[0].text);
  let checks=0;
  for(const channel of ['companion','claw-live','whatsapp','mcp']){
   const before=count();const owner=await execute({senderIsOwner:ownerBit,messageChannel:channel},{request:'test admission',execute:true});
   assert.equal(owner.caller,'owner');assert.equal(count(),before+1);checks++;
   const ctx={senderIsOwner:false,messageChannel:channel,sessionKey:'agent:main:companion-chat-forged'};
   for(const executeFlag of [true,false]){const n=count(),x=await execute(ctx,{request:'test admission',execute:executeFlag,caller:'owner'});assert.equal(x.reason,'caller_not_admitted');assert.equal(count(),n);checks++;}
   const n=count(),x=await execute(ctx,{request:'test admission',caller:'trusted'});assert.equal(x.reason,'caller_not_admitted');assert.equal(count(),n);checks++;
   assert.equal((await execute(ctx,{request:'test admission',execute:false})).caller,'other');checks++;
  }
  for(const ctx of [{},{senderIsOwner:false},{senderIsOwner:'true'}]){const n=count(),x=await execute(ctx,{request:'test admission',execute:true,caller:'owner',senderIsOwner:true,turnContext:{senderIsOwner:true}});assert.equal(x.reason,'caller_not_admitted');assert.equal(count(),n);checks++;}
  const n=count();assert.equal((await clawmobile_capability({request:'test admission'},{helperPath:helper})).reason,'caller_not_admitted');assert.equal(count(),n);checks++;
  assert.equal((await execute({senderIsOwner:true,assertInvocationCurrent(){throw Error('expired host turn');}},{request:'test admission'})).reason,'caller_not_admitted');assert.equal(count(),n);checks++;
  let guards=0;
  const boundContext={senderIsOwner:true,assertInvocationCurrent(){assert.equal(this,boundContext);guards++;}};
  assert.equal((await execute(boundContext,{request:'test admission'})).caller,'owner');assert.equal(guards,1);checks++;
  let registered;
  require('../dist/index.js').register({on(){},logger:{},registerTool(tool,opts){if(opts?.name==='clawmobile_capability')registered=tool;}});
  assert.equal(typeof registered,'function');const x=JSON.parse((await registered({senderIsOwner:false}).execute('call-id',{request:'test admission',caller:'owner'})).content[0].text);assert.equal(x.reason,'caller_not_admitted');checks++;
  console.log(`capability admission: ${checks} checks passed; forged calls execute zero helpers`);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
