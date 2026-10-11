const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {prepareAgentCapabilityGuard:guard}=require('../dist/capabilityAgentGuard.js');
const protocol=fs.readFileSync(path.join(__dirname,'../fixtures/protocol/openclaw-2026.9.6/e3-hook-excerpts.d.ts'),'utf8');
assert.match(protocol,/requester\?: PluginHookToolRequesterContext/);assert.match(protocol,/readonly senderIsOwner\?: boolean/);assert.match(protocol,/block\?: boolean/);assert.match(protocol,/params\?: Record<string, unknown>/);
const event={toolName:'clawmobile_capability',params:{request:'lecture',caller:'owner',risk:'read',operatorTarget:false,decision:{risk:'read'},turnContext:{senderIsOwner:true}}};
const blocked={block:true,blockReason:'capability_first_required'};let checks=4;
for(const context of [{},{senderIsOwner:true},{requester:{}},{requester:{senderIsOwner:'true'}}]){assert.deepEqual(guard(event,context,{risk:'read',operatorTarget:false}),blocked);checks++;}
for(const evidence of [undefined,{}, {risk:'read'}, {operatorTarget:false},{risk:'write',operatorTarget:false},{risk:'read',operatorTarget:true},{risk:[],operatorTarget:false}]){assert.deepEqual(guard(event,{requester:{senderIsOwner:true}},evidence),blocked);checks++;}
for(const owner of [true,false]){
 const admitted=guard({toolName:event.toolName,params:{request:"lecture",caller:"owner"}},{requester:{senderIsOwner:owner}},{risk:'read',operatorTarget:false});
 assert.equal(admitted.params.caller,owner?'owner':'other');assert.equal(event.params.caller,'owner');checks+=2;
}
for(const params of [undefined,null,[],42]){assert.deepEqual(guard({toolName:event.toolName,params},{requester:{senderIsOwner:true}},{risk:'read',operatorTarget:false}),blocked);checks++;}
assert.equal(guard({toolName:'unrelated'},{},undefined),undefined);checks++;
for(const request of [undefined,'', '   ',42,{text:'lecture'},'x'.repeat(12001)]){
 assert.deepEqual(guard({toolName:event.toolName,params:{request}},{requester:{senderIsOwner:true}},{risk:'read',operatorTarget:false}),blocked);checks++;
}
// Concrete regressions: accessors used to execute during spread and throw; inherited evidence admitted.
let getterReads=0;
const paramsWithGetter={request:'lecture'};
Object.defineProperty(paramsWithGetter,'caller',{enumerable:true,get(){getterReads++;throw Error('accessor');}});
assert.deepEqual(guard({toolName:event.toolName,params:paramsWithGetter},{requester:{senderIsOwner:true}},{risk:'read',operatorTarget:false}),blocked);
assert.equal(getterReads,0);checks+=2;
const safeEvent={toolName:event.toolName,params:{request:'lecture'}};
for(const proof of [Object.create({risk:'read',operatorTarget:false}),{get risk(){getterReads++;throw Error('accessor');},operatorTarget:false}]){
 assert.deepEqual(guard(safeEvent,{requester:{senderIsOwner:true}},proof),blocked);checks++;
}
assert.equal(getterReads,0);checks++;
assert.deepEqual(guard(safeEvent,{requester:Object.create({senderIsOwner:true})},{risk:'read',operatorTarget:false}),blocked);checks++;
assert.deepEqual(guard(event,{requester:{senderIsOwner:true}},{risk:'read',operatorTarget:false}),blocked);checks++;
const snap=guard(safeEvent,{requester:{senderIsOwner:false}},{risk:'read',operatorTarget:false});
safeEvent.params.request='changed';safeEvent.params.caller='owner';
assert.equal(snap.params.request,'lecture');assert.equal(snap.params.caller,'other');checks+=2;
const trapped=new Proxy({request:'lecture'},{getOwnPropertyDescriptor(){throw Error('inspection');}});
assert.deepEqual(guard({toolName:event.toolName,params:trapped},{requester:{senderIsOwner:true}},{risk:'read',operatorTarget:false}),blocked);checks++;
// The preparation must not silently install a blanket veto or alter legitimate reads.
let hooks=[];require('../dist/index.js').register({on(name,fn){hooks.push([name,fn]);},registerTool(){},logger:{}});
assert.equal(hooks.filter(x=>x[0]==='before_tool_call').length,1);checks++;
console.log(`E3 preparation: ${checks} checks passed; no dispatch and no runtime registration`);
