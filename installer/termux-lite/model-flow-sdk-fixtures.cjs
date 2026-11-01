// Per-version public SDK sources for the model-flow behaviour tests (test-model-flow-setup/-compaction/-native-session).
// 2026.9.6: the S24 production capture of 25/10 (unchanged). 2026.10.9: the upgrade candidate, from the public npm tar
// (fixtures/openclaw-2026.10.9-compat and fixtures/openclaw-2026.10.9-model-flow-sdk, provenance there).
// Sources are read as text and checked by SHA256; patched copies only ever exist in memory. Nothing is imported from
// an OpenClaw package and no model, Gateway or S24 database is reached.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const fixtures=path.resolve(__dirname,'../../openclaw-plugin-mobile-ui/fixtures');
const versionTable=path.resolve(__dirname,'../../openclaw-plugin-mobile-ui/src/companion/openclawSdkVersions.ts');
const descriptor=require('./openclaw-compat/model-flow-selection.json');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

const VERSIONS={
 '2026.9.6':{
  root:'s24-2026-10-25-model-flow-sdk',gzip:false,entries:descriptor.files,
  modules:{setup:'setup-B7DuERIi.mjs',outer:'run-entry-Bg2j-prG.mjs',embedded:'embedded-agent-BaH7wGBd.mjs',hooks:'hooks-CKanWLsK.mjs',
   compact:'compact-lmmQAHsq.mjs',target:'context-engine-maintenance-VqmqPz8h.mjs'},
  modelRef:{root:'s24-2026-10-25-model-flow-sdk',module:'model-ref-profile-BIKs-96s.mjs'},
  // Region boundaries in the hashed modules (they move between versions; the functions themselves are compared below).
  setupEnd:'/**\n* Converts prompt image refs',applierEnd:'//#endregion\nexport { applyHookModelProfile',outerEnd:'\tconst lifecycleGeneration =',
 },
 '2026.10.9':{
  root:'openclaw-2026.10.9-compat',gzip:true,entries:descriptor.packages['2026.10.9'].files,
  // run/setup.ts was folded into the embedded-agent chunk: one module now carries the contract and its consumer.
  modules:{setup:'embedded-agent-DoEPu8ye.mjs',outer:'run-entry-BnMGfzuI.mjs',embedded:'embedded-agent-DoEPu8ye.mjs',hooks:'hooks-CgZHhfMh.mjs',
   compact:'compact-5sjN3p_L.mjs',target:'context-engine-maintenance-lAvtCTBg.mjs',types:'config-contracts-DzLaG7FV.d.ts'},
  modelRef:{root:'openclaw-2026.10.9-model-flow-sdk',module:'model-ref-profile-BNjB2hED.mjs'},
  setupEnd:'/**\n* Converts prompt image refs',applierEnd:'\nexport { MODEL_PROFILE_CONTRACT_VERSION',outerEnd:'\tconst operatorAuthority =',
 },
};

function selectedVersion(argv=process.argv){
 const version=argv[2]??'2026.9.6';
 assert.ok(Object.hasOwn(VERSIONS,version),'unqualified OpenClaw version for model-flow tests: '+version);
 return version;
}
/** The model profile contract row of the plugin's single SDK version table (src/companion/openclawSdkVersions.ts). */
function tableContract(version){
 const source=fs.readFileSync(versionTable,'utf8'),start=source.indexOf(`"${version}": Object.freeze({`);
 assert.ok(start>=0,'version absent from openclawSdkVersions.ts: '+version);
 const row=/modelProfileContract: Object\.freeze\(\{module: "([^"]+)", symbol: "([^"]+)"\}\)/.exec(source.slice(start));
 assert.ok(row,'model profile contract row missing for '+version);
 return {module:row[1],symbol:row[2]};
}
function readFixture(root,name,gzip){
 const file=path.join(fixtures,root,gzip?name+'.gz':name);
 return gzip?zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'):fs.readFileSync(file,'utf8');
}
function extraProvenance(root){return JSON.parse(fs.readFileSync(path.join(fixtures,root,'PROVENANCE.json'),'utf8'));}

function modelFlowSdk(version){
 const spec=VERSIONS[version];assert.ok(spec,'unqualified OpenClaw version: '+version);
 const entry=name=>{const row=spec.entries.find(e=>e.path==='dist/'+name);assert.ok(row,'no model-flow-selection entry for '+name+' in '+version);return row;};
 const original=name=>{const source=readFixture(spec.root,name,spec.gzip);assert.equal(sha(source),entry(name).original,name+' is the exact original module');return source;};
 const patched=name=>{
  const row=entry(name);let source=original(name);
  for(const [before,after] of row.replacements){assert.equal(source.split(before).length,2,name+': anchor occurs exactly once');source=source.replace(before,after);}
  assert.equal(sha(source),row.patched,name+': exact patched module');return source;
 };
 const extra=(root,name)=>{
  const source=fs.readFileSync(path.join(fixtures,root,name),'utf8');
  const prov=extraProvenance(root),row=prov.files.find(f=>f.module===name);assert.ok(row,'no provenance for '+name);
  assert.equal(sha(source),row.sha256);return source;
 };
 return {version,spec,entry,original,patched,extra,sha,contract:tableContract(version),
  modelRef:()=>extra(spec.modelRef.root,spec.modelRef.module)};
}
/** Slice [begin, end) of a module, both markers mandatory, the begin marker unique. */
function region(source,begin,end,label=begin){
 const start=source.indexOf(begin);assert.ok(start>=0&&source.indexOf(begin,start+1)<0,'unique region start: '+label);
 const finish=source.indexOf(end,start+begin.length);assert.ok(finish>start,'region end: '+label);
 return source.slice(start,finish);
}
/** readHookModelProfile/resolveHookModelSelection/applyHookModelProfile of the patched setup module, in a vm. 2026.10.9
 * wraps the awaited hook in the caller's claim admission and guarded-fetch authority: both are the real upstream
 * functions (hooks chunk and fetch-request-authority module), not stand-ins. */
function hookBridge(sdk){
 const {AsyncLocalStorage}=require('node:async_hooks'),vm=require('node:vm');
 const setup=sdk.patched(sdk.spec.modules.setup);
 const functions=region(setup,'function readHookModelProfile(',sdk.spec.setupEnd);
 const applier=region(setup,'function applyHookModelProfile(',sdk.spec.applierEnd);
 const legacy=sdk.version==='2026.9.6';
 const claim=legacy?'':region(sdk.patched(sdk.spec.modules.hooks),'const CLAIM_ADMISSION = ','//#endregion\n//#region src/plugins/hook-decision-types.ts');
 const authority=legacy?'':region(sdk.extra('openclaw-2026.10.9-model-flow-sdk','fetch-request-authority-DJ_0g9EM.mjs'),'const requestAuthority =','//#endregion');
 const quiet={info(){},warn(){}};
 return vm.runInNewContext([claim,authority,functions,applier,'({readHookModelProfile,resolveHookModelSelection,applyHookModelProfile})'].join('\n'),
  {log:quiet,log$3:quiet,Symbol,AsyncLocalStorage,TypeError,Promise,resolveGlobalSingleton:(_key,create)=>create(),isPromiseLike:v=>v!=null&&typeof v.then==='function'});
}
module.exports={VERSIONS,selectedVersion,modelFlowSdk,tableContract,region,sha,fixtures,hookBridge};
