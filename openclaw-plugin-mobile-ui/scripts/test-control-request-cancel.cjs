const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'request-cancel-'));
 const saved={state:process.env.OPENCLAW_STATE_DIR,playbooks:process.env.SAMANTHA_CONTROL_PLAYBOOKS,home:process.env.SAMANTHA_CONTROL_HOME};
 process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;process.env.SAMANTHA_CONTROL_HOME=root;
 await fs.mkdir(path.join(root,'reporting'));await fs.writeFile(path.join(root,'reporting/__init__.py'),'');
 await fs.writeFile(path.join(root,'reporting/control_actions.py'),`import json,sys,hashlib\nfrom pathlib import Path\na=sys.argv;r=Path(a[a.index('--home')+1]);ref=a[a.index('--reference')+1];op=a[a.index('--operation-id')+1];check='--check-only' in a\np=r/'canonical-fixture.json';data=json.loads(p.read_text()) if p.exists() else {};key=ref+':'+op\nif ref=='REQ-9':out={'success':False,'state':'refused','receipt':None,'reason':'cancel_unavailable_for_payment'}\nelif key in data:out=data[key]\nelif check:out={'success':False,'state':'ready','receipt':None}\nelse:\n with (r/'attempts').open('a') as f:f.write(key+'\\n')\n if op=='uncertain':sys.stderr.write('token=private-owner-diagnostic');sys.exit(1)\n out={'success':True,'state':'cancelled','receipt':{'version':1,'action':'cancel_request','operationId':op,'reference':ref,'intentId':hashlib.sha256((op+ref).encode()).hexdigest(),'eventId':'a'*64,'state':'cancelled','at':'2026-10-10T10:00:00+01:00'}}\n data[key]=out;p.write_text(json.dumps(data))\nprint(json.dumps(out))\n`);
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const request=(reference,body,headers={},method='POST')=>new Promise((resolve,reject)=>{
  const content=JSON.stringify(body);const req=http.request({host:'127.0.0.1',port,path:'/v1/control/requests/'+reference+'/cancel',method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(content),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end(content);
 });
 try{
  const owner={'x-clawmobile-owner-flow':'v1'},ledger=path.join(root,'clawmobile-companion/runs.json');
  assert.equal((await request('REQ-1',{operationId:'deny'})).status,403);
  assert.equal((await request('REQ-1',{operationId:'deny'}, {...owner,Origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await request('%',{operationId:'invalid'},owner)).status,400);
  assert.equal((await request('REQ-1',{operationId:'bad',request_id:'caller-id'},owner)).status,400);
  assert.equal((await request('REQ-1',{operationId:'bad'},owner,'GET')).status,405);
  const bank=await request('REQ-9',{operationId:'bank'},owner);assert.equal(bank.status,409);assert.equal(bank.body.reason,'cancel_unavailable_for_payment');await assert.rejects(fs.stat(ledger),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(root,'attempts')),{code:'ENOENT'});
  const first=await request('REQ-1',{operationId:'cancel'},owner);assert.equal(first.status,200);assert.equal(first.body.state,'cancelled');assert.equal(first.body.receipt.eventId,'a'.repeat(64));assert.deepEqual((await request('REQ-1',{operationId:'cancel'},owner)).body,first.body);
  const concurrent=await Promise.all(Array.from({length:4},()=>request('REQ-1',{operationId:'parallel'},owner)));assert.ok(concurrent.some(x=>x.body.state==='cancelled'));assert.ok(concurrent.every(x=>['cancelled','indeterminate'].includes(x.body.state)));
  const unknown=await request('REQ-1',{operationId:'uncertain'},owner);assert.equal(unknown.body.state,'indeterminate');assert.ok(!JSON.stringify(unknown).includes('private-owner-diagnostic'));assert.deepEqual((await request('REQ-1',{operationId:'uncertain'},owner)).body,unknown.body);
  const attempts=(await fs.readFile(path.join(root,'attempts'),'utf8')).trim().split('\n');assert.equal(attempts.filter(x=>x==='REQ-1:parallel').length,1);assert.equal(attempts.filter(x=>x==='REQ-1:uncertain').length,1);
  delete require.cache[require.resolve('../dist/companion/controlActions')];delete require.cache[require.resolve('../dist/companion/runs')];delete require.cache[require.resolve('../dist/companion/nativeOperation')];
  assert.deepEqual(await require('../dist/companion/controlActions').cancelControlRequest('REQ-1',{operationId:'cancel'}),first.body);assert.equal((await require('../dist/companion/controlActions').cancelControlRequest('REQ-1',{operationId:'uncertain'})).state,'indeterminate');
  assert.equal((await fs.readFile(path.join(root,'attempts'),'utf8')).trim().split('\n').length,3);
  console.log('P2-c: HTTP owner/payment boundaries, server reference resolution, canonical receipt, concurrent reservation, restart and uncertainty/no-replay passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));for(const [key,value] of [['OPENCLAW_STATE_DIR',saved.state],['SAMANTHA_CONTROL_PLAYBOOKS',saved.playbooks],['SAMANTHA_CONTROL_HOME',saved.home]])if(value===undefined)delete process.env[key];else process.env[key]=value;await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
