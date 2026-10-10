const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),cp=require('node:child_process');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'diagnostic-'));
 process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_HOME=root;
 if(!process.env.SAMANTHA_CONTROL_PLAYBOOKS){
  process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;await fs.mkdir(path.join(root,'reporting'));await fs.writeFile(path.join(root,'reporting/__init__.py'),'');
  await fs.writeFile(path.join(root,'reporting/control_diagnostic.py'),`import sys,json,io,zipfile,hashlib,base64\nif 'export' in sys.argv:\n b=io.BytesIO()\n with zipfile.ZipFile(b,'w') as z:z.writestr('diagnostic.json',json.dumps({'metadataOnly':True}))\n d=b.getvalue();out={'name':'samantha-diagnostic.zip','mime':'application/zip','metadataOnly':True,'bytes':len(d),'sha256':hashlib.sha256(d).hexdigest(),'encoding':'base64','data':base64.b64encode(d).decode()}\nelse:out={'available':True,'items':[{'at':'2026-10-10T10:00:00Z','level':'INFO','component':'openclaw','event':'observation'}]}\nprint(json.dumps(out))\n`);
 }
 const file=path.join(root,'.openclaw/workspace/logs/companion-openclaw-gateway.log');await fs.mkdir(path.dirname(file),{recursive:true});
 const marker='private-fixture-conversation';await fs.writeFile(file,JSON.stringify({time:'2026-10-10T10:00:00Z',level:'INFO',message:marker,token:marker})+'\n');
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(endpoint,method='GET',body={},headers={})=>new Promise((resolve,reject)=>{
  const data=JSON.stringify(body),req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/control/diagnostic/'+endpoint,method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(data),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end(data);
 });
 try{
  const owner={'x-clawmobile-owner-flow':'v1'};
  assert.equal((await request('export','POST',{operationId:'deny'})).status,403);
  assert.equal((await request('logs/agent','GET',{}, {Origin:'https://example.invalid'})).status,403);
  assert.equal((await request('logs/agent?offset=-1')).status,400);
  assert.equal((await request('export','POST',{operationId:'bad',includeMessages:true},owner)).status,400);
  const page=await request('logs/agent');assert.equal(page.status,200);assert.equal(page.body.items.length,1);assert.ok(!JSON.stringify(page).includes(marker));
  const first=await request('export','POST',{operationId:'export'},owner);assert.equal(first.status,200);assert.equal(first.body.state,'completed');assert.equal(first.body.artifact.mime,'application/zip');
  const data=Buffer.from(first.body.artifact.data,'base64');assert.equal(crypto.createHash('sha256').update(data).digest('hex'),first.body.artifact.sha256);
  const unpack=cp.spawnSync('python3',['-c','import sys,io,zipfile;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));print("\\n".join(z.read(n).decode() for n in z.namelist()))'],{input:data,encoding:'utf8'});assert.equal(unpack.status,0);assert.ok(!unpack.stdout.includes(marker));
  await fs.writeFile(file,'changed');assert.deepEqual((await request('export','POST',{operationId:'export'},owner)).body,first.body);
  const parallel=await Promise.all(Array.from({length:3},()=>request('export','POST',{operationId:'parallel'},owner)));assert.ok(parallel.some(x=>x.body.state==='completed'));assert.ok(parallel.every(x=>['completed','indeterminate'].includes(x.body.state)));
  console.log('P2-e: diagnostic owner boundary, bounded metadata-only logs/export, archive digest, durable replay and concurrency passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
