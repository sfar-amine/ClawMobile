const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawn}=require("node:child_process");

const tmp=process.env.TMPDIR||path.join(os.homedir(),".cache","tmp");
fs.mkdirSync(tmp,{recursive:true});
const root=fs.mkdtempSync(path.join(tmp,"continuum-capability-bridge-"));
const bridgeDir=path.join(root,"bridge");
const continuumDir=path.join(root,"continuum");
const helper=path.join(root,"fake-capability.py");
fs.writeFileSync(helper,[
"import base64,json,sys",
"mode=sys.argv[1];request=sys.argv[2];args=sys.argv[3:]",
"write='write' in request",
"if mode=='execute-decision':",
" decision=json.loads(base64.b64decode(args[args.index('--decision-b64')+1]).decode())",
" out={'mode':mode,'decisionId':decision.get('decisionId'),'capability':decision.get('capability'),'execution':{'state':'completed','result':{'ok':True,'kind':'write' if write else 'read','decisionId':decision.get('decisionId')}}}",
"else:",
" surface=args[args.index('--surface')+1];caller=args[args.index('--caller')+1]",
" out={'surface':surface,'caller':caller,'capability':'device.assistance','selected':{'capability':'device.assistance','risk':'write' if write else 'read','authorized':True,'deterministic':True,'state':'ready'}}",
" if mode=='execute': out['execution']={'state':'completed','result':{'ok':True,'kind':'write' if write else 'read'}}",
"print(json.dumps(out))",""
].join("\n"));
fs.chmodSync(helper,0o700);
const node=path.join(os.homedir(),".openclaw-android","bin","node");
const companion=path.resolve(__dirname,"..","dist","companion","server.js");
const base="http://127.0.0.1:8881/v1/extensions/remote-bridge";

function h(method,params){return crypto.createHash("sha256").update(JSON.stringify({method,params})).digest("hex");}
function state({taskId,stepId,requestId,method,params,risk,epoch=1}){
 const attemptId="a1",effectKey=taskId+"-effect";
 const fence={version:1,attemptId,effectKey,ownershipEpoch:epoch,ownerId:"owner-a",bootId:"boot-a"};
 return {version:3,run_id:taskId,state:"running",owner:{id:"owner-a",boot_id:"boot-a",lease_until:Date.now()/1000+120},
  continuum:{control:"active",ownership_epoch:epoch,current_attempt:attemptId,attempts:{[attemptId]:{
   state:"submitted",request_id:requestId,effect_key:effectKey,mutation_risk:risk,
   transport_binding:{version:1,taskId,stepId,requestId,method,paramsHash:h(method,params)},
   ...(risk==="read"?{}:{dispatch_fence:fence})
  }}}};
}
function writeState(v){
 fs.mkdirSync(continuumDir,{recursive:true});
 fs.writeFileSync(path.join(continuumDir,v.run_id+".json"),JSON.stringify(v));
 fs.writeFileSync(path.join(continuumDir,v.run_id+".events.jsonl"),JSON.stringify({taskId:v.run_id,after:v})+"\n");
}
async function req(payload){
 const r=await fetch(base+"/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
 let body={};try{body=await r.json();}catch{}
 return {code:r.status,body};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitHealth(){
 for(let i=0;i<100;i++){try{const r=await fetch(base+"/health");if((await r.json()).ok)return;}catch{}await sleep(25);}
 throw Error("health_timeout");
}
async function stop(p){if(p.exitCode===null){p.kill("SIGTERM");await Promise.race([new Promise(r=>p.once("exit",r)),sleep(1000)]);}}

(async()=>{
 const proc=spawn(node,[companion],{env:{...process.env,CLAWMOBILE_COMPANION_PORT:"8881",CLAWMOBILE_WHATSAPP_LISTENER_WATCHDOG:"0",
  CLAWMOBILE_CHATGPT_VOICE_RECOVERY:"0",CLAWMOBILE_REMOTE_BRIDGE_DIR:bridgeDir,CLAW_CONTINUUM_FOREGROUND_DIR:continuumDir,
  CLAW_CAPABILITY_HELPER:helper},stdio:["ignore","pipe","pipe"]});
 try{
  await waitHealth();
  const readDecision={version:2,type:"EXECUTE",decisionId:"decision-read",requestId:"cap-read-request",capability:"device.assistance",risk:"read"};
  const readParams={request:"durable read fixture",targetHint:"",surface:"claw_live",caller:"owner",decision:readDecision};
  const readState=state({taskId:"cap-read",stepId:"continuum-read",requestId:"cap-read-request",method:"capability_execute_readonly",params:readParams,risk:"read"});
  writeState(readState);
  let out=await req({requestId:"cap-read-request",taskId:"cap-read",stepId:"continuum-read",method:"capability_execute_readonly",params:readParams});
  assert.equal(out.code,200);assert.equal(out.body.state,"completed");assert.equal(out.body.mutationRisk,"read");
  assert.equal(out.body.result?.mode,"execute-decision");assert.equal(out.body.result?.decisionId,"decision-read");
  assert.equal(out.body.result?.execution?.result?.kind,"read");assert.equal(out.body.result?.execution?.result?.decisionId,"decision-read");

  const writeDecision={version:2,type:"EXECUTE",decisionId:"decision-write",requestId:"cap-write-request",capability:"device.assistance",risk:"write"};
  const writeParams={request:"write fixture",targetHint:"",surface:"claw_live",caller:"owner",decision:writeDecision};
  const writeStateValue=state({taskId:"cap-write",stepId:"continuum-write",requestId:"cap-write-request",method:"capability_execute_owner",params:writeParams,risk:"write"});
  writeState(writeStateValue);
  const fence=writeStateValue.continuum.attempts.a1.dispatch_fence;
  out=await req({requestId:"cap-write-request",taskId:"cap-write",stepId:"continuum-write",method:"capability_execute_owner",params:writeParams,continuumFence:fence});
  assert.equal(out.code,200);assert.equal(out.body.state,"completed");assert.equal(out.body.mutationRisk,"write");
  assert.equal(out.body.result?.mode,"execute-decision");assert.equal(out.body.result?.decisionId,"decision-write");
  assert.equal(out.body.result?.execution?.result?.kind,"write");assert.equal(out.body.continuumFence?.attemptId,"a1");

  const staleParams={request:"write stale",targetHint:"",surface:"claw_live",caller:"owner"};
  const stale=state({taskId:"cap-stale",stepId:"continuum-stale",requestId:"cap-stale-request",method:"capability_execute_owner",params:staleParams,risk:"write",epoch:2});
  writeState(stale);
  out=await req({requestId:"cap-stale-request",taskId:"cap-stale",stepId:"continuum-stale",method:"capability_execute_owner",params:staleParams,
    continuumFence:{...stale.continuum.attempts.a1.dispatch_fence,ownershipEpoch:1}});
  assert.equal(out.code,409);
  console.log(JSON.stringify({suite:"continuum-capability-bridge",read:true,writeFence:true,staleEpochRejected:true}));
 }finally{await stop(proc);fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
