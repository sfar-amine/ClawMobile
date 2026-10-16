const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createRequire}=require('node:module');
const {resolveMemoSdkEntries,loadMemoMediaOwner,installedMemoSdkRoot,MEMO_SDK_ROOT_TIMEOUT_MS,transcribeMemoAttachment}=require('../dist/companion/memoSttOwner');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memo-sdk-resolution-'));
const missing=()=>{throw Object.assign(new Error('synthetic missing'),{code:'MODULE_NOT_FOUND'});};
// This is a synthetic public SDK package, never a S24/provider proof.
function fixture(name,version='2026.9.6',omitAuth=false){
 const folder=path.join(root,name,'openclaw');fs.mkdirSync(folder,{recursive:true});
 const modules={'media-understanding-runtime':'export async function runMediaUnderstandingFile(){return {text:"synthetic offline"}}',
  'config-runtime':'export function loadConfig(){return {synthetic:true}}',
  'agent-runtime':'export async function resolveApiKeyForProvider(){return {profileId:"synthetic",mode:"api-key"}}'};
 const exports={};for(const [name,source] of Object.entries(modules)){
  if(omitAuth&&name==='agent-runtime')continue;
  fs.writeFileSync(path.join(folder,name+'.js'),source);exports['./plugin-sdk/'+name]='./'+name+'.js';
 }
 const manifest=path.join(folder,'package.json');fs.writeFileSync(manifest,JSON.stringify({name:'openclaw',version,type:'module',exports}));
 return {root:path.dirname(folder),folder,resolve:createRequire(manifest).resolve};
}
(async()=>{
 // Product admission remains closed before any SDK resolution/import, npm or file access.
 const {MEMO_STT_QUALIFICATION}=require('../dist/companion/memoSttBoundary');
 const child=require('node:child_process');const Module=require('node:module');
 const originals={execFile:child.execFile,resolve:Module._resolveFilename};
 const ioNames=['readFileSync','statSync','realpathSync','openSync','closeSync'];
 const originalIo=Object.fromEntries(ioNames.map(name=>[name,fs[name]]));let forbidden=0;
 try{
  child.execFile=()=>{forbidden++;throw Error('no npm under closed admission');};
  Module._resolveFilename=()=>{forbidden++;throw Error('no SDK under closed admission');};
  for(const name of ioNames)fs[name]=()=>{forbidden++;throw Error('no file access under closed admission');};
  assert.deepEqual(await transcribeMemoAttachment('synthetic-owned-audio'),MEMO_STT_QUALIFICATION);
  assert.equal(forbidden,0);
 }finally{child.execFile=originals.execFile;Module._resolveFilename=originals.resolve;Object.assign(fs,originalIo);}
 const local=fixture('local');let discoveries=0;
 const localEntries=await resolveMemoSdkEntries(local.resolve,async()=>{discoveries++;throw Error('must not discover');});
 assert.equal(discoveries,0);assert.equal(localEntries.length,3);
 const owner=await loadMemoMediaOwner(async()=>localEntries);
 assert.deepEqual(owner.loadConfig(),{synthetic:true});
 assert.deepEqual(await owner.runMediaUnderstandingFile({}),{text:'synthetic offline'});
 assert.equal(typeof owner.resolveApiKeyForProvider,'function');
 const global=fixture('global');const globalEntries=await resolveMemoSdkEntries(missing,async()=>global.root+'\n');
 assert.ok(globalEntries.every(x=>x.startsWith(global.folder+path.sep)));
 assert.equal((await loadMemoMediaOwner(async()=>globalEntries)).loadConfig().synthetic,true);
 for(const output of ['', 'relative/path',global.root+'\n/second/root',global.root+'\0', 'x'.repeat(4097)])
  await assert.rejects(resolveMemoSdkEntries(missing,async()=>output),/memo_transcript_unavailable/);
 await assert.rejects(resolveMemoSdkEntries(missing,async()=>path.join(root,'not-installed')),/memo_transcript_unavailable/);
 await assert.rejects(resolveMemoSdkEntries(missing,async()=>{throw Error('synthetic private timeout');}),/memo_transcript_unavailable/);
 const wrong=fixture('wrong','2026.9.7');await assert.rejects(resolveMemoSdkEntries(missing,async()=>wrong.root),/memo_transcript_unavailable/);
 const partial=fixture('partial','2026.9.6',true);let partialFallback=0;
 await assert.rejects(resolveMemoSdkEntries(partial.resolve,async()=>{partialFallback++;return global.root;}),/memo_transcript_unavailable/);
 assert.equal(partialFallback,0);
 // Review regression: the FIRST public export is declared, but its file is absent.
 // A different public export remains resolvable: package presence must close fallback.
 const firstMissing=fixture('first-missing');fs.unlinkSync(path.join(firstMissing.folder,'media-understanding-runtime.js'));
 assert.ok(firstMissing.resolve('openclaw/plugin-sdk/config-runtime'));
 await assert.rejects(resolveMemoSdkEntries(firstMissing.resolve,async()=>{partialFallback++;return global.root;},[firstMissing.root]),/memo_transcript_unavailable/);
 const allMissing=fixture('all-missing');
 for(const name of ['media-understanding-runtime','config-runtime','agent-runtime'])fs.unlinkSync(path.join(allMissing.folder,name+'.js'));
 await assert.rejects(resolveMemoSdkEntries(allMissing.resolve,async()=>{partialFallback++;return global.root;},[allMissing.root]),/memo_transcript_unavailable/);
 const noExports=fixture('no-exports');const noManifest=path.join(noExports.folder,'package.json');
 fs.writeFileSync(noManifest,JSON.stringify({name:'openclaw',version:'2026.9.6',type:'module',exports:{}}));
 await assert.rejects(resolveMemoSdkEntries(noExports.resolve,async()=>{partialFallback++;return global.root;},[noExports.root]),/memo_transcript_unavailable/);
 assert.equal(partialFallback,0);
 const badExport=fixture('bad-export');fs.writeFileSync(path.join(badExport.folder,'agent-runtime.js'),'export const unrelated=true');
 await assert.rejects(loadMemoMediaOwner(()=>resolveMemoSdkEntries(missing,async()=>badExport.root)),/memo_transcript_unavailable/);
 // Real execFile boundary: fixed npm arguments, no shell, bounded output and timeout.
 const bin=path.join(root,'bin');fs.mkdirSync(bin);const npm=path.join(bin,'npm');const oldPath=process.env.PATH;
 try{
  process.env.PATH=bin+path.delimiter+oldPath;
  const write=source=>fs.writeFileSync(npm,'#!'+process.execPath+'\n'+source,{mode:0o700});
  write('if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["root","-g"]))process.exit(1);process.stdout.write('+JSON.stringify(global.root+'\n')+');');
  assert.equal(await installedMemoSdkRoot(),global.root+'\n');
  write('process.stdout.write("x".repeat(8192));');await assert.rejects(installedMemoSdkRoot(),/memo_transcript_unavailable/);
  write('setInterval(()=>{},1000);');const start=performance.now();
  await assert.rejects(installedMemoSdkRoot(),/memo_transcript_unavailable/);
  assert.ok(performance.now()-start>=MEMO_SDK_ROOT_TIMEOUT_MS-100);
 }finally{process.env.PATH=oldPath;}
 const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/hs8/media-config-and-sdk-resolution.json'),'utf8'));
 assert.equal(capture.sdkExports.resolvableFromInstalledCompanion,false);
 assert.deepEqual(capture.toolsMedia['tools.media.models'],[]);
 console.log('HS8 public SDK resolution: local/global ESM, package version/export boundaries, unavailable root, bounded npm output and timeout passed; synthetic SDK only, no providers');
})().catch(()=>{console.error('HS8 public SDK resolution contract failed');process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
