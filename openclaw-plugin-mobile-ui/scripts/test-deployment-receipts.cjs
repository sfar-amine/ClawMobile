const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),{performance}=require('node:perf_hooks');
const fixture=require('../fixtures/s24-2026-10-10/g4/deploy-receipts.json');
(async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'g4-deploys-'));process.env.SAMANTHA_CONTROL_HOME=home;
 const dir=path.join(home,'.openclaw/deploys');await fs.mkdir(dir,{recursive:true});
 for(const sample of fixture.samples)await fs.writeFile(path.join(dir,sample.filename),JSON.stringify(sample.receipt));
 const before=await Promise.all(fixture.samples.map(x=>fs.readFile(path.join(dir,x.filename),'utf8')));
 const {readDeploymentReceipts,latestCompanionDeploymentAt}=require('../dist/companion/deploymentReceipts');
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const get=(suffix='',method='GET',headers={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/control/deploys'+suffix,method,headers},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));});req.on('error',reject);req.end();});
 try{
  let physical=0;const open=fs.open;fs.open=async(...args)=>{if(args[0]===home)physical++;return open(...args);};
  let start=performance.now();const concurrent=await Promise.all(Array.from({length:10},()=>get()));assert.ok(performance.now()-start<500);assert.equal(physical,1);fs.open=open;
  const view=concurrent[0].body;assert.equal(view.state,'ok');assert.equal(view.items.length,fixture.samples.length);
  const first=fixture.samples.find(x=>x.kind==='companion'&&x.receipt.state==='deployed');assert.equal(view.items.find(x=>x.target===first.receipt.target).checksCount,44);assert.equal(await latestCompanionDeploymentAt(first.receipt.target),new Date(first.receipt.at).toISOString());
  assert.equal(await latestCompanionDeploymentAt('not-a-hash'),null);assert.equal(await latestCompanionDeploymentAt('eeeeeee'),null);
  const app=fixture.samples.find(x=>x.kind==='app'&&x.receipt.state==='installed');assert.equal(view.items.find(x=>x.target===app.receipt.commit).appVersion,app.receipt.appVersion??null);
  assert.ok(!JSON.stringify(view).includes('detail'));assert.ok(!JSON.stringify(view).includes('route'));
  for(const suffix of ['?limit=0','?limit=51','?limit=1&limit=2','?output=true'])assert.equal((await get(suffix)).status,400);
  for(const header of ['Origin','Referer','Sec-Fetch-Site'])assert.equal((await get('', 'GET',{[header]:'cross-site'})).status,403);
  for(const method of ['POST','PUT','DELETE'])assert.equal((await get('',method)).status,405);
  assert.equal((await get('?limit=1')).body.items.length,1);
  assert.deepEqual(await Promise.all(fixture.samples.map(x=>fs.readFile(path.join(dir,x.filename),'utf8'))),before);
  // Negative cases mutate the captured owner shape, never claim invented captures.
  const bad={...first.receipt,state:'rolled_back',at:'2026-10-11T00:00:00Z',detail:'private@example.invalid token=secret',acceptance:{checks:[{status:'fail',code:503,route:'private@example.invalid',stdout:'secret'}]}};
  await fs.writeFile(path.join(dir,'companion-20261011T000000.json'),JSON.stringify(bad));
  await fs.symlink('/etc/passwd',path.join(dir,'app-20261011T000001.json'));await fs.writeFile(path.join(dir,'app-20261011T000002.json'),'{');await fs.writeFile(path.join(dir,'app-20261011T000003.json'),'x'.repeat(262145));await fs.mkdir(path.join(dir,'companion-20261011T000004.json'));
  await new Promise(r=>setTimeout(r,1010));const negative=await readDeploymentReceipts();assert.equal(negative.state,'partial');assert.equal(negative.items[0].rollback,true);assert.deepEqual(negative.items[0].failedChecks,[{check:1,code:503}]);assert.ok(!JSON.stringify(negative).includes('@'));assert.ok(!JSON.stringify(negative).includes('secret'));assert.equal(await latestCompanionDeploymentAt(first.receipt.target),null);
  // Replace the .openclaw pathname after opening it: children must stay on the original fd.
  await new Promise(r=>setTimeout(r,1010));let replaced=false;const realOpen=fs.open;
  fs.open=async(...args)=>{const handle=await realOpen(...args);if(!replaced&&String(args[0]).endsWith('/.openclaw')){replaced=true;await fs.rename(path.join(home,'.openclaw'),path.join(home,'.openclaw-retained'));await fs.mkdir(path.join(home,'.openclaw/deploys'),{recursive:true});}return handle;};
  const anchored=await readDeploymentReceipts();fs.open=realOpen;assert.equal(replaced,true);assert.ok(anchored.items.length>0);
  await fs.rm(path.join(home,'.openclaw'),{recursive:true});await fs.rename(path.join(home,'.openclaw-retained'),path.join(home,'.openclaw'));
  // 600 real-shape receipts, latest filename last in directory iteration, mixed owners.
  await fs.rm(dir,{recursive:true});await fs.mkdir(dir);for(let i=0;i<600;i++){const date=new Date(Date.UTC(2026,9,1)+i*1000);const stamp=date.toISOString().slice(0,19).replace(/[-:]/g,'');const kind=i%2?'app':'companion';const source=kind==='app'?app:first;await fs.writeFile(path.join(dir,`${kind}-${stamp}.json`),JSON.stringify({...source.receipt,at:date.toISOString()}));}
  await new Promise(r=>setTimeout(r,1010));start=performance.now();const volume=await get('?limit=50');const cold=performance.now()-start;assert.ok(cold<500,`cold ${cold}`);assert.equal(volume.body.items.length,50);assert.equal(volume.body.items[0].at,new Date(Date.UTC(2026,9,1)+599000).toISOString());assert.ok(volume.body.issues.includes('receipt_read_limit'));assert.equal(await latestCompanionDeploymentAt(first.receipt.target),null);
  // Symlinked owner parent must not escape the runtime directory.
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'g4-outside-'));await fs.mkdir(path.join(outside,'deploys'));await fs.writeFile(path.join(outside,'deploys',first.filename),JSON.stringify(first.receipt));
  await fs.rm(path.join(home,'.openclaw'),{recursive:true});await fs.symlink(outside,path.join(home,'.openclaw'));await new Promise(r=>setTimeout(r,1010));assert.equal((await readDeploymentReceipts()).state,'unavailable');await fs.rm(outside,{recursive:true});
  console.log(JSON.stringify({routeBudgetMs:500,cold600ReceiptsMs:Math.round(cold),ownerReceiptCount:22,capturedSamples:8,singleFlight:true,privacy:true,ownerFilesUnchanged:true}));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
