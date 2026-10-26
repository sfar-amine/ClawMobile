// Closed fake RPC lifecycle only. No live Gateway, model, provider or tool executor is called.
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const path=require('node:path');
const {prepareMainToolCatalog,MAIN_TOOLS_PREPARE_BUDGET_MS}=require('../dist/companion/openclawGatewayClient');
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
const catalog={agentId:'main',profiles:[],groups:[{id:'core',tools:[{id:'read',description:'PRIVATE_SENTINEL'}]},{id:'plugins',tools:[{id:'clawmobile_capability',parameters:{PRIVATE_SENTINEL:true}}]}]};
(async()=>{
 await test('cold and warm metadata reads share the SDK-owned fake registry without a model turn',async()=>{
  let now=0,warm=false,registryLoads=0;const calls=[];
  const rpc=async(method,params,options)=>{calls.push({method,params,options});if(!warm){registryLoads++;warm=true;now+=1200;}else now+=3;return catalog;};
  const cold=await prepareMainToolCatalog(rpc,()=>now);assert.equal(cold.state,'ready');assert.equal(cold.elapsed_ms,1200);
  const hot=await prepareMainToolCatalog(rpc,()=>now);assert.equal(hot.state,'ready');assert.equal(hot.elapsed_ms,3);
  assert.equal(registryLoads,1);assert.equal(calls.length,2);
  for(const c of calls){assert.equal(c.method,'tools.catalog');assert.deepEqual(c.params,{agentId:'main',includePlugins:true});assert.deepEqual(c.options,{timeoutMs:20000,hardTimeoutMs:20000});}
  assert.equal(cold.groups,2);assert.equal(cold.tools,2);assert(!JSON.stringify(cold).includes('PRIVATE_SENTINEL'));
 });
 await test('private CLI default reuses the official Gateway client and closes only its own socket',async()=>{
  const owner=require('../dist/companion/openclawAgentClient');const previousCall=owner.callOpenClawGateway,previousClose=owner.closeOpenClawGateway;
  let calls=0,closed=0;
  try{
   owner.callOpenClawGateway=async(method,params)=>{calls++;assert.equal(method,'tools.catalog');assert.deepEqual(params,{agentId:'main',includePlugins:true});return catalog;};
   owner.closeOpenClawGateway=()=>{closed++;};
   const result=await prepareMainToolCatalog(undefined,()=>0);assert.equal(result.state,'ready');assert.equal(calls,1);assert.equal(closed,1);
  }finally{owner.callOpenClawGateway=previousCall;owner.closeOpenClawGateway=previousClose;}
 });
 await test('late metadata is explicit unverified within its own budget, never a retry',async()=>{
  let now=0,calls=0;const result=await prepareMainToolCatalog(async()=>{calls++;now=20001;return catalog;},()=>now);
  assert.equal(result.state,'unverified');assert.equal(result.reason,'tools_catalog_budget_exceeded');assert.equal(result.budget_ms,MAIN_TOOLS_PREPARE_BUDGET_MS);assert.equal(calls,1);
 });
 await test('transport rejection never leaks the cause or dispatches an agent/tool fallback',async()=>{
  let calls=0;const result=await prepareMainToolCatalog(async()=>{calls++;throw Error('PRIVATE_SENTINEL');},()=>0);
  assert.equal(result.state,'unverified');assert.equal(result.reason,'tools_catalog_unavailable');assert.equal(calls,1);assert(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
 });
 await test('wrong agent, malformed response and excessive catalogues fail closed',async()=>{
  for(const value of [null,{}, {...catalog,agentId:'contacts'}, {...catalog,groups:{}}, {...catalog,groups:Array(257).fill({tools:[]})}, {...catalog,groups:[{tools:Array(4097).fill({})}]}]){
   const result=await prepareMainToolCatalog(async()=>value,()=>0);assert.equal(result.state,'unverified');assert.equal(result.reason,'tools_catalog_invalid');
  }
 });
 await test('private preparation CLI accepts no agent selection or arbitrary method',()=>{
  const entry=path.resolve(__dirname,'../dist/companion/openclawGatewayClient.js');
  for(const args of [['--prepare-main-tools','contacts'],['--prepare-main-tools','agent'],['--prepare-main-tools','--method','agent']]){
   const result=cp.spawnSync(process.execPath,[entry,...args],{encoding:'utf8',timeout:3000});assert.equal(result.status,2);assert.deepEqual(JSON.parse(result.stdout),{success:false});
  }
 });
 console.log('PASS '+passed+' metadata preparation contracts; synthetic cold/warm timings are not S24 gains');
})().catch(e=>{console.error(e);process.exitCode=1;});
