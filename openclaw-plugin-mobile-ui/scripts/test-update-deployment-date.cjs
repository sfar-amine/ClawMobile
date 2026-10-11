const assert=require('node:assert/strict');
(async()=>{
 const {withCompanionDeploymentDate:bind}=require('../dist/companion/updateDeploymentDate');
 const captured=require('../fixtures/s24-2026-10-10/p0-3/updates.json');assert.equal(captured._capture.sanitized,true);
 const original=captured.response,source=JSON.stringify(original),target='a'.repeat(40);let calls=0;
 const unknown=await bind(original,target,async commit=>{calls++;assert.equal(commit,target);return null;});
 assert.equal(unknown.items.find(x=>x.id==='companion').deployedAt,null);assert.equal(JSON.stringify(original),source);
 for(const row of original.items){const changed=unknown.items.find(x=>x.id===row.id);assert.deepEqual(changed,row.id==='companion'?{...row,deployedAt:null}:row);}
 assert.equal(calls,1);await bind(original,null,async()=>{throw Error('must not query owner without target');});
 // Pure normalization cases are synthetic, not deployment proofs or S24 dates.
 for(const date of ['2026-10-10T12:30:00+00:00','2026-10-10T13:30:00.123456+01:00']){
  const projected=await bind(original,target,async()=>date);assert.equal(projected.items.find(x=>x.id==='companion').deployedAt,new Date(date).toISOString());
  assert.equal(projected.items.find(x=>x.id==='companion').version,original.items.find(x=>x.id==='companion').version);
 }
 for(const date of ['not-a-date','2026-10-10','2026-02-30T00:00:00Z','2026-10-10T24:00:00Z',42,undefined])assert.equal((await bind(original,target,async()=>date)).items.find(x=>x.id==='companion').deployedAt,null);
 assert.equal((await bind(original,target,async()=>{throw Error('owner unavailable');})).items.find(x=>x.id==='companion').deployedAt,null);
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process'),{performance}=require('node:perf_hooks');
 const receipts=require('../fixtures/s24-2026-10-10/g4/deploy-receipts.json');assert.equal(receipts.capture.readOnly,true);assert.equal(receipts.samples.length,8);assert.equal(receipts.capture.counts.companion+receipts.capture.counts.app,22);
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'g5-updates-')),dir=path.join(home,'.openclaw/deploys');await fs.mkdir(dir,{recursive:true});
 process.env.SAMANTHA_CONTROL_HOME=home;process.env.SAMANTHA_TIER0_NATIVE=path.resolve(__dirname,'../../installer/termux-lite/tier0-native-read.py');
 for(const sample of receipts.samples)await fs.writeFile(path.join(dir,sample.filename),JSON.stringify(sample.receipt));
 const {latestCompanionDeploymentAt:owner}=require('../dist/companion/deploymentReceipts');
 const first=receipts.samples.find(x=>x.kind==='companion'&&x.receipt.state==='deployed');
 // Positive binding with an unchanged real receipt and its actual deployed target.
 const actual=await bind(original,first.receipt.target,owner);assert.equal(actual.items.find(x=>x.id==='companion').deployedAt,new Date(first.receipt.at).toISOString());
 assert.equal((await bind(original,'e'.repeat(40),owner)).items.find(x=>x.id==='companion').deployedAt,null);
 // Declared shape-preserving variation: this checkout is not deployed on the S24.
 // Match only the target to local HEAD to exercise the real /updates wiring.
 const head=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'}).trim();assert.match(head,/^[a-f0-9]{40}$/);
 const matching=path.join(home,'matching/.openclaw/deploys');await fs.mkdir(matching,{recursive:true});
 for(const sample of receipts.samples)await fs.writeFile(path.join(matching,sample.filename),JSON.stringify(sample===first?{...sample.receipt,target:head}:sample.receipt));
 process.env.SAMANTHA_CONTROL_HOME=path.join(home,'matching');
 const snapshot=async()=>Promise.all(receipts.samples.map(x=>fs.readFile(path.join(matching,x.filename),'utf8')));const before=await snapshot();
 let helperCalls=0,ownerOpens=0;const exec=cp.execFile,open=fs.open;
 cp.execFile=function(command,args,...rest){if(command==='python3'&&args[0]===process.env.SAMANTHA_TIER0_NATIVE){helperCalls++;return setTimeout(()=>exec.call(this,command,args,...rest),captured._capture.latencyMs);}return exec.call(this,command,args,...rest);};
 fs.open=async(...args)=>{if(args[0]===process.env.SAMANTHA_CONTROL_HOME)ownerOpens++;return open(...args);};
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const get=()=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port,path:'/v1/updates'},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));}).on('error',reject);});
 try{
  const start=performance.now(),views=await Promise.all(Array.from({length:10},get)),coldMs=performance.now()-start;assert.ok(coldMs<4000,`/updates budget ${coldMs}`);
  assert.equal(helperCalls,1);assert.equal(ownerOpens,1);
  for(const view of views){assert.equal(view.status,200);assert.equal(view.body.items.find(x=>x.id==='companion').deployedAt,new Date(first.receipt.at).toISOString());assert.equal(view.body.items.find(x=>x.id==='companion').version,require('../package.json').version+'+'+head.slice(0,7));assert.equal(view.body.receipt,null);assert.deepEqual(view.body.actions,[]);assert.equal(view.body.items.length,4);assert.ok(!JSON.stringify(view.body).includes('@'));assert.ok(!JSON.stringify(view.body).includes('acceptance'));}
  await Promise.all(Array.from({length:10},get));assert.equal(helperCalls,1);assert.equal(ownerOpens,1);assert.deepEqual(await snapshot(),before);
  // No matching receipt: re-key both existing owner caches by an empty home.
  const absent=path.join(home,'absent');await fs.mkdir(absent);process.env.SAMANTHA_CONTROL_HOME=absent;const missing=await get();assert.equal(missing.status,200);assert.equal(missing.body.items.find(x=>x.id==='companion').deployedAt,null);
  console.log(JSON.stringify({suite:'G5-deployment-date-binding',passed:true,actualReceiptSamples:8,ownerReceiptCount:22,route:'/v1/updates',budgetMs:4000,injectedCapturedLatencyMs:captured._capture.latencyMs,coldConcurrent10Ms:Math.round(coldMs),singleFlight:true,ownerFilesUnchanged:true,physicalDeployment:false}));
 }finally{cp.execFile=exec;fs.open=open;server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
