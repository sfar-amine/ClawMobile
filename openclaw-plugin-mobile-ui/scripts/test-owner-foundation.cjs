// L2 uses the S24 SDK's cacheable system hook. Authored payload contract tests; actual SDK metadata is captured.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const cp=require('node:child_process'),owner=require('../dist/ownerBootstrapContext');
const sdk=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-25-foundation/sdk-context.json'),'utf8'));
assert.equal(sdk.openclaw,'2026.9.6');assert.ok(sdk.hooks.matches.some(r=>r.text.includes('prependSystemContext')));assert.ok(sdk.cache.matches.some(r=>r.text.includes('MAX_BOOTSTRAP_SNAPSHOTS = 64')));
const payload={version:1,sha256:'a'.repeat(64),stable_sha256:'b'.repeat(64),revision:3239,estimated_tokens:300,content:'Canonical rules sentinel.',instruction:'Do not reread startup files.',skills:[{name:'samantha-mobile',description:'Operate the authorized phone.',path:'skills/samantha-mobile/SKILL.md'}]};
let reads=0;const read=()=>{reads++;return JSON.stringify(payload);};
assert.equal(owner.ownerFoundationContext({read}),'');assert.equal(reads,0);
const text=owner.ownerFoundationContext({authority:'owner',read});assert.ok(text.includes('SAMANTHA_FOUNDATION'));assert.ok(text.includes('revision=3239'));assert.ok(text.includes('skills/samantha-mobile/SKILL.md'));
const memoryA={...payload, content:payload.content+'\nMemory snapshot A'};
const memoryB={...payload, sha256:'c'.repeat(64), revision:3240, content:payload.content+'\nMemory snapshot B'};
const first=owner.ownerFoundationContext({authority:'owner',read:()=>JSON.stringify(memoryA)});
const next=owner.ownerFoundationContext({authority:'owner',read:()=>JSON.stringify(memoryB)});
const stableEnd=first.indexOf('Memory snapshot A');assert.ok(stableEnd>0);
assert.equal(first.slice(0,stableEnd),next.slice(0,stableEnd),'memory freshness changes must preserve the cacheable rules/skills prefix');
assert.notEqual(first,next,'fresh memory and revision are still injected, never served stale');

assert.throws(()=>owner.ownerFoundationContext({authority:'owner',read:()=>JSON.stringify({...payload,content:'x'.repeat(24001)})}),/budget/);
assert.throws(()=>owner.ownerFoundationContext({authority:'owner',read:()=>JSON.stringify({...payload,skills:[{name:'samantha-mobile',description:'x',path:'../../private.md'}]})}),/skill/);
const original=cp.execFileSync,flag=process.env.SAMANTHA_CONTEXT_FOUNDATION;
try{
 process.env.SAMANTHA_CONTEXT_FOUNDATION='1';cp.execFileSync=()=>read();const before=reads;
 for(const agentId of ['contacts','contacts-projet','contacts-pulse','engineering-lite'])assert.equal(owner.ownerFoundationHook({}, {agentId,workspaceDir:path.join(os.homedir(),'.openclaw','workspace')}),undefined);
 assert.equal(owner.ownerFoundationHook({}, {agentId:'main',workspaceDir:'/other'}),undefined);assert.equal(reads,before,'contacts and other workspaces never read private owner context');
 assert.equal(owner.ownerFoundationHook({}, {agentId:'main',workspaceDir:path.join(os.homedir(),'.openclaw','workspace'),sessionKey:'agent:main:companion-chat-test'}),undefined,'Companion already uses the shared extraSystemPrompt producer');
 const hook=owner.ownerFoundationHook({}, {agentId:'main',workspaceDir:path.join(os.homedir(),'.openclaw','workspace'),sessionKey:'agent:main:whatsapp:test'});assert.equal(hook.prependSystemContext,text);assert.equal(reads,before+1);
 const voiceRoot=fs.mkdtempSync(path.join(os.tmpdir(),'foundation-voice-context-'));
 try{
  const file=path.join(voiceRoot,'.openclaw/workspace/memory/voice/amine.md');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,'Authored surface-specific voice context sentinel.');
  const compact=require('../dist/companion/clawLive').compactOwnerAgentContext;
  const delegated=compact({authority:'owner',home:voiceRoot,voiceDelegation:true});
  assert.ok(delegated.startsWith(text),'voice preserves the common stable foundation before its own surface context');
  assert.ok(delegated.includes('## VOICE_CONTEXT\nAuthored surface-specific voice context sentinel.'));
  assert.ok(delegated.includes('## VOICE_TURN'));
  assert.ok(!compact({authority:'owner',home:voiceRoot}).includes('surface-specific voice context sentinel'),'other surfaces do not inherit voice-specific memory');
 }finally{fs.rmSync(voiceRoot,{recursive:true,force:true});}
 process.env.SAMANTHA_CONTEXT_FOUNDATION='0';assert.equal(owner.ownerFoundationHook({}, {agentId:'main'}),undefined);
}finally{cp.execFileSync=original;if(flag===undefined)delete process.env.SAMANTHA_CONTEXT_FOUNDATION;else process.env.SAMANTHA_CONTEXT_FOUNDATION=flag;}
// The existing host loader owns persistence; no real environment/configuration is read.
const envRoot=fs.mkdtempSync(path.join(os.tmpdir(),'foundation-host-env-'));
try{
 const envFile=path.join(envRoot,'owner.env');fs.writeFileSync(envFile,'PRIVATE_SENTINEL=authored-test-only\nSAMANTHA_CONTEXT_FOUNDATION=1\n',{mode:0o600});
 const loader=path.resolve(__dirname,'../../installer/termux-lite/lib.sh');
 const load=(inherited)=>cp.execFileSync('bash',['-c','source "$1"; clawmobile_load_openclaw_env; printf "%s" "$SAMANTHA_CONTEXT_FOUNDATION"','foundation-env-test',loader],
  {encoding:'utf8',env:{PATH:process.env.PATH,OPENCLAW_ENV_FILE:envFile,...(inherited===undefined?{}:{SAMANTHA_CONTEXT_FOUNDATION:inherited})}});
 assert.equal(load(undefined),'1');assert.equal(load('0'),'0','nonempty inherited rollback value takes precedence');
 fs.writeFileSync(envFile,'PRIVATE_SENTINEL=authored-test-only\nSAMANTHA_CONTEXT_FOUNDATION=0\n');
 assert.equal(load(undefined),'0');assert.equal(load('1'),'1','persisted flag alone does not prove that a running owner reloaded it');
}finally{fs.rmSync(envRoot,{recursive:true,force:true});}
console.log('PASS L2 cacheable shared owner foundation, strict bounded producer, contacts isolation, no duplicate Companion bootstrap');
