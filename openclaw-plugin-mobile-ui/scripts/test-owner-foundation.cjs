// L2 uses the S24 SDK's cacheable system hook. Authored payload contract tests; actual SDK metadata is captured.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const cp=require('node:child_process'),owner=require('../dist/ownerBootstrapContext');
const sdk=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-25-foundation/sdk-context.json'),'utf8'));
assert.equal(sdk.openclaw,'2026.9.6');assert.ok(sdk.hooks.matches.some(r=>r.text.includes('prependSystemContext')));assert.ok(sdk.cache.matches.some(r=>r.text.includes('MAX_BOOTSTRAP_SNAPSHOTS = 64')));
const payload={version:1,sha256:'a'.repeat(64),stable_sha256:'b'.repeat(64),revision:3239,estimated_tokens:300,content:'Canonical rules sentinel.',instruction:'Do not reread startup files.',skills:[{name:'samantha-mobile',description:'Operate the authorized phone.',path:'skills/samantha-mobile/SKILL.md'}]};
let reads=0;const read=()=>{reads++;return JSON.stringify(payload);};
assert.equal(owner.ownerFoundationContext({read}),'');assert.equal(reads,0);
const text=owner.ownerFoundationContext({authority:'owner',read});assert.ok(text.includes('SAMANTHA_FOUNDATION'));assert.ok(text.includes('revision=3239'));assert.ok(text.includes('skills/samantha-mobile/SKILL.md'));
assert.throws(()=>owner.ownerFoundationContext({authority:'owner',read:()=>JSON.stringify({...payload,content:'x'.repeat(24001)})}),/budget/);
assert.throws(()=>owner.ownerFoundationContext({authority:'owner',read:()=>JSON.stringify({...payload,skills:[{name:'samantha-mobile',description:'x',path:'../../private.md'}]})}),/skill/);
const original=cp.execFileSync,flag=process.env.SAMANTHA_CONTEXT_FOUNDATION;
try{
 process.env.SAMANTHA_CONTEXT_FOUNDATION='1';cp.execFileSync=()=>read();const before=reads;
 for(const agentId of ['contacts','contacts-projet','contacts-pulse','engineering-lite'])assert.equal(owner.ownerFoundationHook({}, {agentId,workspaceDir:path.join(os.homedir(),'.openclaw','workspace')}),undefined);
 assert.equal(owner.ownerFoundationHook({}, {agentId:'main',workspaceDir:'/other'}),undefined);assert.equal(reads,before,'contacts and other workspaces never read private owner context');
 assert.equal(owner.ownerFoundationHook({}, {agentId:'main',workspaceDir:path.join(os.homedir(),'.openclaw','workspace'),sessionKey:'agent:main:companion-chat-test'}),undefined,'Companion already uses the shared extraSystemPrompt producer');
 const hook=owner.ownerFoundationHook({}, {agentId:'main',workspaceDir:path.join(os.homedir(),'.openclaw','workspace'),sessionKey:'agent:main:whatsapp:test'});assert.equal(hook.prependSystemContext,text);assert.equal(reads,before+1);
 process.env.SAMANTHA_CONTEXT_FOUNDATION='0';assert.equal(owner.ownerFoundationHook({}, {agentId:'main'}),undefined);
}finally{cp.execFileSync=original;if(flag===undefined)delete process.env.SAMANTHA_CONTEXT_FOUNDATION;else process.env.SAMANTHA_CONTEXT_FOUNDATION=flag;}
console.log('PASS L2 cacheable shared owner foundation, strict bounded producer, contacts isolation, no duplicate Companion bootstrap');
