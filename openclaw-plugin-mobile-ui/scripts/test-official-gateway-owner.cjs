'use strict';
// SDK fixtures below are synthetic installed-package/export shapes, never S24 handshake captures.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {officialGatewayConnection,createOfficialGatewayOwner,loadOfficialGatewaySdk,resolveOfficialGatewayConfig,COMPANION_OPERATOR_SCOPES}=require('../dist/companion/officialGatewayOwner');
const wait=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const mock={coerceSecretRef:()=>null,resolveGatewayAuth:({authConfig})=>({mode:authConfig.mode||'token',token:authConfig.token,password:authConfig.password}),resolveGatewayPort:()=>18789};
 const options=officialGatewayConnection(mock,{gateway:{mode:'local',auth:{mode:'token',token:'synthetic fixture value'}}},{});
 assert.throws(()=>officialGatewayConnection({...mock,coerceSecretRef:()=>({source:"env",id:"fixture"})},{gateway:{auth:{token:"synthetic reference"}}},{}));
 assert.equal(options.url,'ws://127.0.0.1:18789');assert.equal(options.deviceIdentity,null);assert.equal(options.mode,'cli');assert.equal(options.role,'operator');assert.deepEqual(options.scopes,['operator.admin','operator.read','operator.write','operator.approvals']);assert(Object.isFrozen(COMPANION_OPERATOR_SCOPES));
 for(const config of [{gateway:{mode:'remote'}},{gateway:{tls:{enabled:true}}},{gateway:{auth:{token:{source:'env',id:'fixture'}}}},{gateway:{auth:{mode:'trusted-proxy'}}}])assert.throws(()=>officialGatewayConnection(mock,config,{}));
 assert.throws(()=>officialGatewayConnection(mock,{}, {OPENCLAW_GATEWAY_URL:'ws://fixture.invalid'}));assert.throws(()=>officialGatewayConnection({...mock,resolveGatewayPort:()=>0},{gateway:{auth:{mode:'none'}}},{}));
 let resolved=0;
 const config={gateway:{mode:'local',auth:{mode:'token',token:{source:'store',provider:'fixture',id:'synthetic'}}}};
 const withRefs={...mock,coerceSecretRef:v=>v&&typeof v==='object'?v:null,resolveSecretRefValues:async(refs,options)=>{resolved++;assert.equal(refs.length,1);assert.equal(options.config,config);return new Map([['opaque','synthetic owner credential']]);}};
 const prepared=await resolveOfficialGatewayConfig(withRefs,config,{});assert.equal(resolved,1);assert.equal(prepared.gateway.auth.token,'synthetic owner credential');assert.equal(typeof config.gateway.auth.token,'object');
 assert.equal(officialGatewayConnection(withRefs,prepared,{}).token,'synthetic owner credential');
 await assert.rejects(resolveOfficialGatewayConfig({...withRefs,resolveSecretRefValues:async()=>{throw Error('private provider fixture');}},config,{}),e=>e.message==='gateway_sdk_auth_refused');
 await assert.rejects(resolveOfficialGatewayConfig({...withRefs,resolveSecretRefValues:async()=>new Map()},config,{}),e=>e.message==='gateway_sdk_auth_refused');
 let ownerOptions,stop=0,hello=0,closed=0,requests=0,errors=[];
 const sdk={...mock,loadConfig:()=>({gateway:{auth:{mode:'none'}}}),GatewayClient:class{constructor(o){ownerOptions=o;this.connected=true;}start(){}stop(){stop++;}async request(method,params,opts){requests++;return opts;}}};
 const callbacks={onHelloOk:()=>hello++,onClose:()=>closed++,onConnectError:e=>errors.push(e)};
 const owner=createOfficialGatewayOwner(callbacks,'fixture',async()=>sdk);owner.start();await wait();assert.equal(owner.connected,false);await assert.rejects(owner.request('fixture.method',{}, {timeoutMs:10}),/gateway_sdk_not_ready/);
 ownerOptions.onHelloOk();assert.equal(owner.connected,true);assert.equal(hello,1);const signal=new AbortController().signal;assert.equal((await owner.request('fixture.method',{}, {timeoutMs:10,signal})).signal,signal);assert.equal(requests,1);ownerOptions.onClose(1006);assert.equal(owner.connected,false);assert.equal(closed,1);
 owner.stop();assert.equal(stop,1);ownerOptions.onHelloOk();assert.equal(hello,1);
 let release;const late=createOfficialGatewayOwner(callbacks,'fixture',()=>new Promise(r=>release=r));late.start();late.stop();release(sdk);await wait();assert.equal(hello,1);
 for(const e of [Object.assign(new Error('synthetic private detail'),{code:'ENOENT'}),new Error('synthetic private detail')]){const x=createOfficialGatewayOwner(callbacks,'fixture',async()=>{throw e});x.start();await wait();assert.equal(errors.at(-1).message,e.code==='ENOENT'?'ENOENT':'gateway_sdk_init_refused');x.stop();}
 const configFail=createOfficialGatewayOwner(callbacks,'fixture',async()=>({...sdk,loadConfig:()=>{throw new Error('synthetic private configuration detail')}}));configFail.start();await wait();assert.equal(errors.at(-1).message,'gateway_sdk_config_refused');configFail.stop();
 // Global executable symlink -> self-referencing package exports, not a bespoke import of private SDK files.
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'official-owner-fixture-'));try{
  const root=path.join(temp,'global/lib/node_modules/openclaw'),bin=path.join(temp,'global/bin');await fs.mkdir(path.join(root,'dist/plugin-sdk'),{recursive:true});await fs.mkdir(bin,{recursive:true});
  const exports={};for(const name of ['gateway-runtime','config-runtime','gateway-config-runtime','secret-ref-runtime'])exports['./plugin-sdk/'+name]='./dist/plugin-sdk/'+name+'.js';
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.6',type:'module',exports}));await fs.writeFile(path.join(root,'openclaw.mjs'),'// Synthetic CLI fixture; must never execute.\n');await fs.symlink(path.join(root,'openclaw.mjs'),path.join(bin,'openclaw'));
  await fs.writeFile(path.join(root,'dist/plugin-sdk/gateway-runtime.js'),'export class GatewayClient{}; export const resolveGatewayAuth=()=>({mode:"none"});\n');
  await fs.writeFile(path.join(root,'dist/plugin-sdk/config-runtime.js'),'export const loadConfig=()=>({gateway:{auth:{mode:"none"}}}); export const coerceSecretRef=()=>null;\n');
  await fs.writeFile(path.join(root,'dist/plugin-sdk/gateway-config-runtime.js'),'export const resolveGatewayPort=()=>18789;\n');
  await fs.writeFile(path.join(root,'dist/plugin-sdk/secret-ref-runtime.js'),'export const resolveSecretRefValues=async()=>new Map();\n');
  const loaded=await loadOfficialGatewaySdk(path.join(bin,'openclaw'));assert.equal(typeof loaded.GatewayClient,'function');assert.equal(loaded.resolveGatewayPort(),18789);
  await assert.rejects(loadOfficialGatewaySdk(path.join(temp,'missing-binary')),e=>e.code==='ENOENT'&&e.message==='ENOENT');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
 console.log('Official Gateway owner: synthetic global exports, canonical SDK configuration, closed local auth, reduced scopes, hello readiness, late-init shutdown and fixed errors passed; no S24 handshake qualification');
})().catch(()=>{console.error('OFFICIAL_GATEWAY_OWNER_TEST_FAILED');process.exitCode=1});
