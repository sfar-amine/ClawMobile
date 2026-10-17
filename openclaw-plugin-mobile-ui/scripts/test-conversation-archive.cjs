const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {performance}=require('node:perf_hooks');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-archive-'));process.env.OPENCLAW_STATE_DIR=root;
 const captured=require('../fixtures/s24-2026-10-10/p0-3/runs.json');
 // Explicit adapter from captured HTTP projection to the existing local registry; not a raw registry capture.
 const original=captured.response.runs.filter(row=>row.state==='done').map(row=>({runId:row.runId,sessionId:row.sessionId,text:row.userText||row.prompt,userText:row.userText||row.prompt,result:row.result,state:'done',acceptedAt:row.submittedAt,updatedAt:row.updatedAt}));
 assert.equal(original.length,13);
 const file=path.join(root,'clawmobile-companion/runs.json');fs.mkdirSync(path.dirname(file));
 fs.writeFileSync(file,JSON.stringify({version:1,runs:original,archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[]}));
 const gateway=require('../fixtures/s24-2026-10-10/ui-recette/gateway.sessions.list.companion.json');
 let calls=0;const client=require('../dist/companion/openclawAgentClient');client.callOpenClawGateway=async(method)=>{assert.equal(method,'sessions.list','archive never mutates Gateway');calls++;await new Promise(r=>setTimeout(r,gateway._capture.latencyMs));return gateway.response;};
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}))}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const owner={'x-clawmobile-owner-flow':'v1'},list='/v1/runs?contract=2&view=conversations&limit=2';
 const request=(url,method='GET',body,headers={})=>new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):null,start=performance.now();const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{'content-type':'application/json',...(data?{'content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),ms:performance.now()-start}));});req.on('error',reject);req.end(data);});
 const id=original[0].sessionId,url='/v1/conversations/'+id+'/archive';
 try{
  const before=fs.readFileSync(file,'utf8');
  assert.equal((await request('/v1/conversations/unknown/archive','POST',{operationId:'guard'})).status,403);assert.equal(fs.readFileSync(file,'utf8'),before);
  for(const headers of [{Origin:'https://example.invalid'},{Referer:'https://example.invalid'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await request(url,'POST',{operationId:'guard'},{...owner,...headers})).status,403);
  assert.equal((await request(url,'GET',undefined,owner)).status,405);
  for(const [target,body,status]of [[url,{operationId:'extra',other:true},400],['/v1/conversations/%/archive',{operationId:'percent'},400],['/v1/conversations/unknown/archive',{operationId:'absent'},404]])assert.equal((await request(target,'POST',body,owner)).status,status);
  assert.equal(fs.readFileSync(file,'utf8'),before,'preflight refusals never reserve an operation');
  const first=await request(list);assert.equal(first.status,200);assert.ok(first.ms<300);assert.ok(first.body.nextCursor);assert.equal(calls,1);
  // Cold list remains local while the real captured 1.632s Gateway read runs once in background.
  const cold=await Promise.all(Array.from({length:10},()=>request(list)));assert.ok(cold.every(x=>x.ms<300));assert.equal(calls,1);
  const body={operationId:'archive-real-fixture'};
  const parallel=await Promise.all(Array.from({length:8},()=>request(url,'POST',body,owner)));assert.ok(parallel.every(x=>x.status===200&&x.ms<2000));for(const row of parallel)assert.deepEqual(row.body,parallel[0].body);
  const receipt=parallel[0].body;assert.equal(receipt.state,'completed');assert.equal(receipt.artifact.archived,true);
  assert.deepEqual((await request(url,'POST',body,owner)).body,receipt);
  const replay=require('node:child_process').spawnSync(process.execPath,['-e',`require('./dist/companion/conversationArchive').changeConversationArchive(${JSON.stringify(id)},true,${JSON.stringify(body)}).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>process.exit(1))`],{cwd:path.join(__dirname,'..'),env:{...process.env,OPENCLAW_STATE_DIR:root},encoding:'utf8'});assert.equal(replay.status,0);assert.deepEqual(JSON.parse(replay.stdout),receipt,'receipt survives process restart');
  assert.equal((await request('/v1/conversations/'+id+'/unarchive','POST',body,owner)).status,409);
  const stored=JSON.parse(fs.readFileSync(file));assert.equal(stored.runs.filter(x=>x.clientRunId==='native-operation-'+body.operationId).length,1);assert.deepEqual(stored.runs.filter(x=>original.some(y=>y.runId===x.runId)),original);
  const active=await request(list),archived=await request(list+'&archived=1');assert.ok(active.body.items.every(x=>x.sessionId!==id));assert.equal(archived.body.items[0].sessionId,id);assert.equal(archived.body.items[0].archived,true);assert.ok(archived.ms<300);
  assert.equal((await request(list+'&cursor='+encodeURIComponent(first.body.nextCursor))).status,409);
  assert.equal((await request(list+'&archived=1&cursor='+encodeURIComponent(active.body.nextCursor))).status,409);
  assert.equal((await request(list+'&archived=bogus')).status,400);
  const turns=await require('../dist/companion/runs').conversationTurnsPage(id,{limit:20});assert.ok(turns.turns.some(row=>row.runId===original[0].runId),'archive keeps retained turns readable');
  const visibleTurns=await request('/v1/sessions/'+id+'/turns?contract=2&limit=20');assert.equal(visibleTurns.status,200);assert.ok(visibleTurns.body.turns.some(row=>row.runId===original[0].runId));
  const restored=await request('/v1/conversations/'+id+'/unarchive','POST',{operationId:'restore'},owner);assert.equal(restored.body.state,'completed');assert.equal(restored.body.artifact.archived,false);
  assert.ok((await request('/v1/runs?contract=2&view=conversations&limit=40')).body.items.some(row=>row.sessionId===id));
  const saved=JSON.parse(fs.readFileSync(file));saved.runs.find(row=>row.sessionId===id).state='running';fs.writeFileSync(file,JSON.stringify(saved));const protectedBefore=fs.readFileSync(file,'utf8');assert.equal((await request(url,'POST',{operationId:'active-protected'},owner)).status,409);assert.equal(fs.readFileSync(file,'utf8'),protectedBefore);
  saved.runs.find(row=>row.sessionId===id).state='done';saved.paymentRequests=[{state:'requires_bank_action'}];fs.writeFileSync(file,JSON.stringify(saved));const bankBefore=fs.readFileSync(file,'utf8');assert.equal((await request(url,'POST',{operationId:'bank-protected'},owner)).status,409);assert.equal(fs.readFileSync(file,'utf8'),bankBefore);
  saved.paymentRequests=[];saved.ownerConfirmations=[{state:'awaiting_owner',expiresAt:Date.now()+120000}];fs.writeFileSync(file,JSON.stringify(saved));const confirmationBefore=fs.readFileSync(file,'utf8');assert.equal((await request(url,'POST',{operationId:'confirmation-protected'},owner)).status,409);assert.equal(fs.readFileSync(file,'utf8'),confirmationBefore);saved.ownerConfirmations=[];
  // Scale list pagination from real captured row shape up to the owner's existing 500-run bound.
  saved.paymentRequests=[];saved.runs=Array.from({length:500},(_,n)=>({...original[n%original.length],runId:'volume-'+n,sessionId:'volume-'+n,acceptedAt:1000+n,updatedAt:2000+n}));saved.archivedSessionIds=saved.runs.filter((_,n)=>n%2===0).map(x=>x.sessionId);fs.writeFileSync(file,JSON.stringify(saved));
  const pages=require('../dist/companion/runs');for(const archived of [false,true]){let cursor,seen=new Set();do{const page=await pages.conversationSummariesPage({limit:40,archived,cursor});page.items.forEach(x=>{assert.equal(x.archived,archived);assert.ok(!seen.has(x.sessionId));seen.add(x.sessionId)});cursor=page.nextCursor;}while(cursor);assert.equal(seen.size,250);}
  const boundBefore=fs.readFileSync(file,'utf8');
  for(const n of [0,499])for(const suffix of ['archive','unarchive']){
   const failed=await request('/v1/conversations/volume-'+n+'/'+suffix,'POST',{operationId:'capacity-'+n+'-'+suffix},owner);
   assert.equal(failed.status,503);assert.equal(failed.body.error,'archive_capacity_exceeded');assert.equal(fs.readFileSync(file,'utf8'),boundBefore,'full owner refuses before any historical row or flag changes');
   assert.deepEqual((await request('/v1/conversations/volume-'+n+'/'+suffix,'POST',{operationId:'capacity-'+n+'-'+suffix},owner)).body,failed.body);
  }
  // Already reserved/completed receipts replay even at full capacity.
  saved.runs=[...stored.runs,...saved.runs.slice(0,500-stored.runs.length)];saved.archivedSessionIds=stored.archivedSessionIds;fs.writeFileSync(file,JSON.stringify(saved));
  assert.deepEqual((await request(url,'POST',body,owner)).body,receipt);
  saved.runs=Array.from({length:499},(_,n)=>({...original[n%original.length],runId:'boundary-'+n,sessionId:'boundary-'+n,acceptedAt:1000+n,updatedAt:2000+n})).reverse();saved.archivedSessionIds=[];fs.writeFileSync(file,JSON.stringify(saved));
  const edges=await Promise.all([0,498].map(n=>request('/v1/conversations/boundary-'+n+'/archive','POST',{operationId:'boundary-'+n},owner)));
  assert.deepEqual(edges.map(x=>x.status).sort(),[200,503]);const full=JSON.parse(fs.readFileSync(file));assert.equal(full.runs.length,500);assert.equal(full.runs.filter(x=>x.runId.startsWith('boundary-')).length,499);assert.ok(full.runs.some(x=>x.runId==='boundary-0'),'last history row survives');
  const denied=edges.findIndex(x=>x.status===503),retryId=[0,498][denied],retryBody={operationId:'boundary-'+retryId};full.runs=full.runs.filter(x=>!['boundary-1','boundary-2'].includes(x.runId));fs.writeFileSync(file,JSON.stringify(full));assert.equal((await request('/v1/conversations/boundary-'+retryId+'/archive','POST',retryBody,owner)).body.state,'completed','capacity refusal never reserves operation and can retry after space becomes available');
  // Byte boundary includes the final receipt, not merely its shorter running reservation.
  saved.runs=[{...original[0],runId:'byte-boundary',sessionId:'byte-boundary',result:''}];saved.archivedSessionIds=[];const overhead=Buffer.byteLength(JSON.stringify(saved));saved.runs[0].result='X'.repeat(8*1024*1024-256-overhead);fs.writeFileSync(file,JSON.stringify(saved));const bytesBefore=fs.readFileSync(file,'utf8');
  const byteRefusal=await request('/v1/conversations/byte-boundary/archive','POST',{operationId:'byte-boundary'},owner);assert.equal(byteRefusal.status,503);assert.equal(byteRefusal.body.error,'archive_capacity_exceeded');assert.equal(fs.readFileSync(file,'utf8'),bytesBefore);
  console.log(JSON.stringify({suite:'conversation-archive' ,passed:true,capturedDoneRuns:13,retainedRows:500,cliLatencyMs:gateway._capture.latencyMs,concurrentGatewayCalls:calls,retainedHistoryPreserved:true}));
 }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
