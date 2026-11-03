'use strict';
// OpenClaw SDK version table: 2026.9.6 (production) unchanged, 2026.10.9 (candidate) from the public npm tar.
// Fixtures: fixtures/openclaw-sdk-surface/openclaw-<version>.json, export maps and facade export lists read from the
// real npm packages (provenance in each file). Installed packages below are rebuilt from those lists: real subpaths
// and export names, synthetic bodies that only report where they came from. No OpenClaw code runs here.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {OPENCLAW_SDK_VERSIONS,openclawSdkVersion,surfaceSubpaths}=require('../dist/companion/openclawSdkVersions');
const owner=require('../dist/companion/ownerTurnGateway');
const official=require('../dist/companion/officialGatewayOwner');
const {exportNames,qualify,contractHashesFromManifest}=require('./qualify-openclaw-sdk.cjs');
const FIXTURES=path.join(__dirname,'../fixtures/openclaw-sdk-surface');
const MANIFEST=JSON.parse(fs.readFileSync(path.join(__dirname,'../../installer/termux-lite/openclaw-compat/model-flow-selection.json'),'utf8'));
const fixture=version=>JSON.parse(fs.readFileSync(path.join(FIXTURES,`openclaw-${version}.json`),'utf8'));
const counts={};const count=name=>{counts[name]=(counts[name]||0)+1;};
const view=data=>({version:data.version,facade:s=>data.plugin_sdk[s]??null,chunk:c=>data.chunks[c]??null});

(async()=>{
 // Real npm facts the table relies on.
 const v906=fixture('2026.9.6'),v1009=fixture('2026.10.9');
 assert.equal(v906.tarball.sha256,'1a7355691bc0e605222ba818f1f72c1787253c78dfeb0df6be2086ec73b71e63');
 assert.equal(v1009.tarball.sha256,'43c61a00ef2c73416a072a7216cb3be80555d6740199f07194da2714283b04ab');
 assert.equal(v1009.plugin_sdk['config-runtime'],null,'2026.10.9 removed plugin-sdk/config-runtime');
 assert.ok(v906.plugin_sdk['config-runtime'].exports.includes('loadConfig'));
 assert.ok(!Object.values(v1009.plugin_sdk).some(f=>f?.exports.includes('loadConfig')),'2026.10.9 exports no loadConfig');
 assert.equal(v906.chunks['dist/setup-B7DuERIi.mjs'].sha256,contractHashesFromManifest(MANIFEST,'2026.9.6','dist/setup-B7DuERIi.mjs')[0]);
 assert.equal(v1009.chunks['dist/setup-B7DuERIi.mjs'],null,'hashed 2026.9.6 chunk name is gone in 2026.10.9');
 assert.equal(v1009.chunks['dist/embedded-agent-DoEPu8ye.mjs'].sha256,contractHashesFromManifest(MANIFEST,'2026.10.9','dist/embedded-agent-DoEPu8ye.mjs')[0]);
 count('npm_facts');

 // The table qualifies on both real packages, and only on its own version.
 for(const data of [v906,v1009]){
  const hashes=contractHashesFromManifest(MANIFEST,data.version,OPENCLAW_SDK_VERSIONS[data.version].modelProfileContract.module);
  assert.deepEqual(qualify(OPENCLAW_SDK_VERSIONS,data.version,view(data),{contractHashes:hashes}),[]);
  // Unpatched npm chunk: the contract export only exists once model-flow-selection is applied.
  assert.deepEqual(qualify(OPENCLAW_SDK_VERSIONS,data.version,view(data),{requireContractExport:true}),['modelProfileContract:export_absent:MODEL_PROFILE_CONTRACT_VERSION']);
  count('qualified_'+data.version);
 }
 const crossed=qualify(OPENCLAW_SDK_VERSIONS,'2026.9.6',view(v1009));
 assert.ok(crossed.includes('ownerTurn.getRuntimeConfig:subpath_absent:config-runtime')&&crossed.includes('modelProfileContract:chunk_absent:dist/setup-B7DuERIi.mjs'),crossed.join());
 assert.deepEqual(qualify(OPENCLAW_SDK_VERSIONS,'2026.10.8',view(v1009)),['version_not_in_table:2026.10.8']);
 const shadow={...OPENCLAW_SDK_VERSIONS['2026.10.9'],ownerTurn:{...OPENCLAW_SDK_VERSIONS['2026.10.9'].ownerTurn,coerceSecretRef:['secret-input-runtime','coerceSecretRef'],resolveSecretRefValues:['secret-ref-runtime','resolveSecretRefValues']}};
 assert.ok(qualify({'2026.10.9':shadow},'2026.10.9',view(v1009)).some(e=>e.startsWith('ownerTurn.coerceSecretRef:shadowed_by:')),'spread order is checked');
 assert.deepEqual(exportNames('import { a as b } from "./x.mjs";\nexport { b as c, d, e as default };\nexport const F = 1;\nexport async function g(){}'),['F','c','d','default','g']);
 count('qualifier_refusals');

 // Production rows are the subpaths, chunk and order used before the table.
 const p=OPENCLAW_SDK_VERSIONS['2026.9.6'];
 assert.deepEqual(surfaceSubpaths(p.ownerTurn),['gateway-runtime','config-runtime','gateway-config-runtime']);
 assert.deepEqual(surfaceSubpaths(p.officialGateway),['gateway-runtime','config-runtime','gateway-config-runtime','secret-ref-runtime']);
 assert.deepEqual(surfaceSubpaths(p.sessionStore),['session-store-runtime','config-runtime']);
 assert.equal(p.modelProfileContract.module,'dist/setup-B7DuERIi.mjs');assert.deepEqual(p.officialGateway.loadConfig,['config-runtime','loadConfig']);
 assert.deepEqual(Object.keys(OPENCLAW_SDK_VERSIONS),['2026.9.6','2026.10.9']);assert.equal(openclawSdkVersion('2026.10.8'),undefined);assert.equal(openclawSdkVersion('constructor'),undefined);
 assert.ok(Object.isFrozen(OPENCLAW_SDK_VERSIONS)&&Object.isFrozen(p.ownerTurn));
 count('production_rows_unchanged');

 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-sdk-versions-'));
 try{
  // Installed package rebuilt from the real export map and export names of one version.
  const install=(data,label,{contractExport=true,version=data.version}={})=>{
   const root=path.join(temp,label,'lib/node_modules/openclaw'),bin=path.join(temp,label,'bin');
   fs.mkdirSync(path.join(root,'dist/plugin-sdk'),{recursive:true});fs.mkdirSync(bin,{recursive:true});
   const exportsMap={};
   for(const [subpath,facade] of Object.entries(data.plugin_sdk)){
    if(!facade)continue;exportsMap['./plugin-sdk/'+subpath]=facade.export;
    const body=facade.exports.map(n=>`export const ${n} = Object.assign(function ${n}() { return ${JSON.stringify(subpath+'#'+n)}; }, {subpath: ${JSON.stringify(subpath)}});`);
    fs.writeFileSync(path.join(root,facade.export),'// Synthetic body; subpath and names from the npm package.\n'+body.join('\n')+'\n');
   }
   for(const [chunk,facts] of Object.entries(data.chunks)){
    if(!facts)continue;fs.mkdirSync(path.dirname(path.join(root,chunk)),{recursive:true});
    fs.writeFileSync(path.join(root,chunk),contractExport?'export const MODEL_PROFILE_CONTRACT_VERSION = 1;\n':'const MODEL_PROFILE_CONTRACT_VERSION = 1;\nexport {};\n');
   }
   fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'openclaw',version,type:'module',exports:exportsMap}));
   fs.writeFileSync(path.join(root,'openclaw.mjs'),'// Synthetic CLI fixture; never executed.\n');
   fs.symlinkSync(path.join(root,'openclaw.mjs'),path.join(bin,'openclaw'));
   return path.join(bin,'openclaw');
  };
  const expected={'2026.9.6':{config:'config-runtime',secret:'config-runtime',coerce:'config-runtime',loadName:'loadConfig'},
   '2026.10.9':{config:'runtime-config-snapshot',secret:'secret-input-runtime',coerce:'secret-ref-runtime',loadName:'getRuntimeConfig'}};
  for(const data of [v906,v1009]){
   const e=expected[data.version],binary=install(data,data.version);
   const gateway=await owner.loadInstalledGatewaySdk(binary);
   assert.equal(gateway.GatewayClient.subpath,'gateway-runtime');assert.equal(gateway.startGatewayClientWhenEventLoopReady.subpath,'gateway-runtime');
   assert.equal(gateway.getRuntimeConfig.subpath,e.config);assert.equal(gateway.resolveConfiguredSecretInputWithFallback.subpath,e.secret);
   assert.equal(gateway.resolveGatewayPort.subpath,'gateway-config-runtime');assert.equal(gateway.resolveGatewayAuth(),'gateway-runtime#resolveGatewayAuth');
   const sessions=await owner.loadInstalledSessionStoreSdk(binary);
   assert.equal(sessions.modelProfileContractVersion,1);assert.equal(sessions.getRuntimeConfig.subpath,e.config);
   for(const k of ['getSessionEntry','listSessionEntries','patchSessionEntry'])assert.equal(sessions[k].subpath,'session-store-runtime');
   assert.equal(typeof sessions.upsertSessionEntry,'function','the whole session module is still spread');
   const sdk=await official.loadOfficialGatewaySdk(binary);
   assert.equal(sdk.loadConfig.subpath,e.config);assert.equal(sdk.loadConfig(),e.config+'#'+e.loadName);
   assert.equal(sdk.coerceSecretRef.subpath,e.coerce);assert.equal(sdk.resolveSecretRefValues.subpath,'secret-ref-runtime');assert.equal(sdk.resolveGatewayPort.subpath,'gateway-config-runtime');
   if(data.version==='2026.9.6'){const media=await official.loadOfficialMediaStore(binary);assert.equal(media.saveMediaBuffer.subpath,'media-store');}
   else await assert.rejects(official.loadOfficialMediaStore(binary),err=>err.code==='qa_document_sdk_unavailable');
   count('loaders_'+data.version);
  }
  // 2026.10.9 without the model-flow-selection export: contract 0, the model profile owner refuses.
  const unpatched=install(v1009,'unpatched',{contractExport:false});
  assert.equal((await owner.loadInstalledSessionStoreSdk(unpatched)).modelProfileContractVersion,0);
  // Any version outside the table is refused before an import, even with a 2026.10.9 layout.
  const unknown=install(v1009,'unknown',{version:'2026.10.8'});
  await assert.rejects(owner.loadInstalledGatewaySdk(unknown),err=>err.code==='owner_transport_version_unsupported');
  await assert.rejects(owner.loadInstalledSessionStoreSdk(unknown),err=>err.code==='owner_transport_version_unsupported');
  await assert.rejects(official.loadOfficialGatewaySdk(unknown),err=>err.code==='gateway_sdk_version_unsupported');
  await assert.rejects(official.loadOfficialMediaStore(unknown),err=>err.code==='gateway_sdk_version_unsupported');
  // A 2026.10.9 package served with the 2026.9.6 rows would miss config-runtime: refused, never half-loaded.
  const mislabelled=install(v1009,'mislabelled',{version:'2026.9.6'});
  await assert.rejects(owner.loadInstalledGatewaySdk(mislabelled),err=>err.code==='owner_transport_unavailable');
  await assert.rejects(official.loadOfficialGatewaySdk(mislabelled),err=>err.code==='gateway_sdk_unavailable');
  count('refusals');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
 console.log(JSON.stringify({test:'OpenClaw SDK version table (2026.9.6 production, 2026.10.9 candidate)',passed:Object.keys(counts).length,cases:counts}));
})().catch(error=>{console.error(error);process.exitCode=1;});
