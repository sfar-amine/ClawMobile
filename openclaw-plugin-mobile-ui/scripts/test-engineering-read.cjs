const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'engineering-read-'));
 process.env.OPENCLAW_STATE_DIR=root;process.env.SAMANTHA_CONTROL_HOME=root;
 if(!process.env.SAMANTHA_CONTROL_PLAYBOOKS)throw Error('Run with SAMANTHA_CONTROL_PLAYBOOKS pointing to the paired canonical R12 source');
 const directory=path.join(root,'.openclaw/continuations/foreground');await fs.mkdir(directory,{recursive:true});
 const marker='private-fixture-conversation';const data=JSON.stringify({kind:'engineering',run_id:marker,state:'blocked',updated_at:1791633600,objective:marker,output:marker,owner:{id:marker,lease_until:1791633700}});await fs.writeFile(path.join(directory,'test.json'),data);
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(suffix='',method='GET',headers={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/control/engineering'+suffix,method,headers},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end()});
 try{
  const first=await request();assert.equal(first.status,200);assert.equal(first.body.items.length,1);assert.equal(first.body.items[0].state,'blocked');assert.equal(first.body.receipt,null);assert.equal(first.body.effectsReplayed,false);assert.ok(!JSON.stringify(first).includes(marker));
  for(const method of ['POST','PUT','DELETE'])assert.equal((await request('',method)).status,405);
  assert.equal((await request('', 'GET', {Origin:'https://example.invalid'})).status,403);assert.equal((await request('', 'GET', {Referer:'https://example.invalid'})).status,403);
  assert.equal((await request('?offset=-1')).status,400);assert.equal((await request('?includeContent=true')).status,400);assert.equal((await request('?limit=1&limit=2')).status,400);assert.equal((await request('/repair')).status,404);
  assert.equal((await request('?revision='+first.body.revision)).status,200);
  await fs.writeFile(path.join(directory,'second.json'),JSON.stringify({kind:'task',run_id:'second',state:'completed',updated_at:1791633601}));assert.equal((await request('?revision='+first.body.revision)).status,409);
  assert.equal((await request('?limit=1')).body.nextOffset,1);assert.equal((await request('?offset=1&limit=1')).body.items.length,1);
  assert.equal(await fs.readFile(path.join(directory,'test.json'),'utf8'),data);assert.deepEqual((await fs.readdir(directory)).sort(),['second.json','test.json']);
  console.log('R12 canonical checkpoint projection: privacy, pagination, revision, HTTP boundary and no repair/lock/write passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
