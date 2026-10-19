// Producer/consumer framing and actual installed-package export discovery, offline only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Readable}=require('node:stream'),{createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {stageQaDocument,cleanupQaDocument,loadOfficialMediaStore,QA_DOCUMENT_MAX_BYTES}=require('../dist/companion/officialGatewayOwner');
const hash=b=>createHash('sha256').update(b).digest('hex');
const body=Buffer.from('synthetic QA document, never actual private content');
const metadata=(bytes=body)=>({filename:'Claw_QA_Livrables.zip',contentType:'application/zip',size:bytes.length,sha256:hash(bytes)});
const frame=(meta,bytes=body)=>Buffer.concat([Buffer.from(JSON.stringify(meta)+'\n'),bytes]);
(async()=>{
 const files=await fs.mkdtemp(path.join(os.tmpdir(),'qa-stage-files-'));
 let calls=0,resolves=0;
 const sdk={saveMediaBuffer:async(bytes,mime,subdir,max,name)=>{calls++;assert.equal(hash(bytes),hash(body));assert.equal(mime,'application/zip');assert.equal(subdir,'outbound');assert.equal(max,20971520);assert.equal(name,'Claw_QA_Livrables.zip');await fs.writeFile(path.join(files,'fixture-document.zip'),bytes);return {id:'fixture-document.zip',path:path.join(files,'fixture-document.zip'),size:bytes.length,contentType:mime};},resolveMediaBufferPath:async(id,dir)=>{resolves++;assert.equal(id,'fixture-document.zip');assert.equal(dir,'outbound');return path.join(files,'fixture-document.zip');}};
 const encoded=frame(metadata());
 const result=await stageQaDocument(Readable.from([encoded.subarray(0,17),encoded.subarray(17,96),encoded.subarray(96)]),'unused',async()=>sdk);
 assert.deepEqual(result,{state:'STAGED',id:'fixture-document.zip',path:path.join(files,'fixture-document.zip'),size:body.length,sha256:hash(body),contentType:'application/zip'});assert.equal(calls,1);assert.equal(resolves,2);
 let loaded=0;const forbid=async()=>{loaded++;throw Error('must not resolve SDK before framing/hash validation');};
 const bad=[frame({...metadata(),filename:'../Claw_QA_Livrables.zip'}),frame({...metadata(),filename:'custom.zip'}),frame({...metadata(),extra:'forbidden'}),frame({...metadata(),contentType:'text/plain'}),frame({...metadata(),size:true}),frame({...metadata(),size:0}),frame({...metadata(),size:QA_DOCUMENT_MAX_BYTES+1}),frame({...metadata(),sha256:'0'.repeat(64)}),frame({...metadata(),size:body.length-1}),frame({...metadata(),size:body.length+1}),Buffer.from(' '.repeat(2049)),Buffer.from('{bad}\n'),Buffer.alloc(0),Buffer.concat([encoded,Buffer.from('x')])];
 for(const bytes of bad)await assert.rejects(stageQaDocument(Readable.from([bytes]),'unused',forbid),e=>/^qa_document_/.test(e.code));assert.equal(loaded,0);
 const max=Buffer.alloc(QA_DOCUMENT_MAX_BYTES,7);let boundaryCalls=0;
 await stageQaDocument(Readable.from([frame(metadata(max),max)]),'unused',async()=>({saveMediaBuffer:async(b,m,s,n,f)=>{boundaryCalls++;assert.equal(b.length,20971520);await fs.writeFile(path.join(files,'max.zip'),b);return {id:'max.zip',path:path.join(files,'max.zip'),size:b.length,contentType:m};},resolveMediaBufferPath:async()=>path.join(files,'max.zip')}));assert.equal(boundaryCalls,1);
 await assert.rejects(stageQaDocument(Readable.from([frame(metadata(max),Buffer.concat([max,Buffer.from('x')]))]),'unused',forbid));assert.equal(loaded,0);
 for(const change of [{size:1},{contentType:'text/plain'},{id:'../escape'},{path:'/private/other.zip'}])await assert.rejects(stageQaDocument(Readable.from([encoded]),'unused',async()=>({...sdk,saveMediaBuffer:async()=>({...result,...change})})),e=>e.code==='qa_document_stage_unverified');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'qa-stage-sdk-'));try{
  const root=path.join(temp,'global/lib/node_modules/openclaw'),bin=path.join(temp,'global/bin');await fs.mkdir(path.join(root,'dist/plugin-sdk'),{recursive:true});await fs.mkdir(bin,{recursive:true});
  const packageFile=path.join(root,'package.json'),pkg={name:'openclaw',version:'2026.9.6',type:'module',exports:{'./plugin-sdk/gateway-runtime':'./dist/plugin-sdk/gateway-runtime.js','./plugin-sdk/media-store':'./dist/plugin-sdk/media-store.js'}};
  await fs.writeFile(packageFile,JSON.stringify(pkg));await fs.writeFile(path.join(root,'openclaw.mjs'),'throw Error("CLI forbidden");');await fs.symlink(path.join(root,'openclaw.mjs'),path.join(bin,'openclaw'));const binary=path.join(bin,'openclaw');
  // Importing Gateway/auth/config at all is forbidden on this path.
  await fs.writeFile(path.join(root,'dist/plugin-sdk/gateway-runtime.js'),'throw Error("Gateway SDK import forbidden");');
  await fs.writeFile(path.join(root,'dist/plugin-sdk/media-store.js'),`export const saveMediaBuffer=async(b,m,s,max,f)=>{if(s!=="outbound"||max!==20971520||f!=="Claw_QA_Livrables.zip")throw Error();return {id:"sdk.zip",path:"/private/sdk.zip",size:b.length,contentType:m}};export const resolveMediaBufferPath=async()=>"/private/sdk.zip";`);
  // Use actual private SDK-like files so post-stage capacity and cleanup are exercised.
  await fs.writeFile(path.join(root,'dist/plugin-sdk/media-store.js'),`import fs from "node:fs/promises";export const saveMediaBuffer=async(b,m,s,max,f)=>{if(s!=="outbound"||max!==20971520||f!=="Claw_QA_Livrables.zip")throw Error();await fs.writeFile(${JSON.stringify(path.join(files,'sdk.zip'))},b);return {id:"sdk.zip",path:${JSON.stringify(path.join(files,'sdk.zip'))},size:b.length,contentType:m}};export const resolveMediaBufferPath=async()=>${JSON.stringify(path.join(files,'sdk.zip'))};`);
  const loadedSdk=await loadOfficialMediaStore(binary);assert.equal(typeof loadedSdk.saveMediaBuffer,'function');
  const cli=path.resolve(__dirname,'../dist/companion/officialGatewayOwner.js');
  const output=spawnSync(process.execPath,[cli,'--qa-stage-document-stdin'],{env:{...process.env,CLAWMOBILE_OPENCLAW_BIN:binary},input:encoded,encoding:'utf8',timeout:1500});assert.equal(output.status,0,output.stderr);assert.equal(output.stderr,'');assert.deepEqual(JSON.parse(output.stdout),{...result,id:'sdk.zip',path:path.join(files,'sdk.zip')});
  const cleaned=spawnSync(process.execPath,[cli,'--qa-cleanup-document-stdin'],{env:{...process.env,CLAWMOBILE_OPENCLAW_BIN:binary},input:JSON.stringify({...metadata(),id:'sdk.zip'}),encoding:'utf8',timeout:1500});assert.equal(cleaned.status,0,cleaned.stderr);assert.equal(cleaned.stderr,'');assert.deepEqual(JSON.parse(cleaned.stdout),{state:'REMOVED',id:'sdk.zip',sha256:hash(body)});await assert.rejects(fs.stat(path.join(files,'sdk.zip')));
  const wrongArg=spawnSync(process.execPath,[cli,'--qa-stage-document-stdin','forbidden'],{input:encoded,encoding:'utf8',timeout:1500});assert.equal(wrongArg.status,1);assert.deepEqual(JSON.parse(wrongArg.stdout),{state:'REFUSED',code:'qa_document_command_refused'});assert.equal(wrongArg.stderr,'');
  pkg.version='2026.9.7';await fs.writeFile(packageFile,JSON.stringify(pkg));await assert.rejects(loadOfficialMediaStore(binary),e=>e.code==='gateway_sdk_version_unsupported');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
 // Cleanup requires the private exact ID, current inode and digest. A mismatching digest preserves it.
 const cleanupMeta={...metadata(),id:'fixture-document.zip'};
 await assert.rejects(cleanupQaDocument(Readable.from([JSON.stringify({...cleanupMeta,sha256:'0'.repeat(64)})]),'unused',async()=>sdk),e=>e.code==='qa_document_cleanup_unverified');
 assert.equal(await fs.readFile(path.join(files,'fixture-document.zip'),'utf8'),body.toString());
 assert.equal((await cleanupQaDocument(Readable.from([JSON.stringify(cleanupMeta)]),'unused',async()=>sdk)).state,'REMOVED');
 await assert.rejects(fs.stat(path.join(files,'fixture-document.zip')));
 // A symlink cannot be used to clean another file, even with the expected content hash.
 const foreign=path.join(files,'foreign.bin');await fs.writeFile(foreign,body);await fs.symlink(foreign,path.join(files,'fixture-document.zip'));
 await assert.rejects(cleanupQaDocument(Readable.from([JSON.stringify(cleanupMeta)]),'unused',async()=>sdk),e=>e.code==='qa_document_cleanup_unverified');assert.equal((await fs.stat(foreign)).size,body.length);await fs.unlink(path.join(files,'fixture-document.zip'));await fs.unlink(foreign);
 // >200MiB of existing files rejects and removes ONLY the newly staged ID. Sparse fixture is cheap.
 const huge=path.join(files,'existing.bin');const handle=await fs.open(huge,'w');await handle.truncate(200*1024*1024);await handle.close();
 await assert.rejects(stageQaDocument(Readable.from([encoded]),'unused',async()=>sdk),e=>e.code==='qa_document_capacity_refused');
 await assert.rejects(fs.stat(path.join(files,'fixture-document.zip')));assert.equal((await fs.stat(huge)).size,200*1024*1024);await fs.unlink(huge);
 await fs.unlink(path.join(files,'max.zip'));
 await Promise.all(Array.from({length:500},(_,i)=>fs.writeFile(path.join(files,'existing-'+i),'')));
 await assert.rejects(stageQaDocument(Readable.from([encoded]),'unused',async()=>sdk),e=>e.code==='qa_document_capacity_refused');
 await assert.rejects(fs.stat(path.join(files,'fixture-document.zip')));assert.equal((await fs.readdir(files)).length,500);
 await fs.rm(files,{recursive:true,force:true});
 const fixtures=path.resolve(__dirname,'../fixtures/qa');
 const api=JSON.parse(await fs.readFile(path.join(fixtures,'sdk-media-store-public-20261018.json'),'utf8'));
 const impl=JSON.parse(await fs.readFile(path.join(fixtures,'sdk-media-store-implementation-public-20261018.json'),'utf8'));
 const declaration=api.files.find(f=>f.path==='dist/store-hcCHco5A.d.ts');assert.equal(declaration.sha256,'8befaed955857846db577fccfe05f61a2b209071bff8811d81810fa092b514ea');assert(declaration.source.some(s=>s.text.includes('saveMediaBuffer(buffer: Buffer')));assert(declaration.source.some(s=>s.text.includes('resolveMediaBufferPath(id: string')));
 const implementation=impl.files.find(f=>f.path==='dist/store-Bg4FPBgJ.mjs');assert.equal(implementation.sha256,'27a6307934ff1d9a846341b9d505acbc4a6fa321e5a159f233f24414f4dace41');assert(implementation.source.some(s=>s.text.includes('async function saveMediaBuffer(')));assert(implementation.source.some(s=>s.text.includes('mode: 448')));
 console.log('QA document staging: bounded raw framing/hash before SDK, fixed names, exact 20MiB boundary, private receipt, post-stage capacity and exact cleanup, installed media-store only, no Gateway/auth/CLI, captured SDK contracts passed (offline; no delivery or retention qualification)');
})().catch(e=>{console.error(e);process.exitCode=1;});
