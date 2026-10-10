const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'notification-sources-'));process.env.SAMANTHA_CONTROL_HOME=root;
 if(!process.env.SAMANTHA_CONTROL_PLAYBOOKS){process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;await fs.mkdir(path.join(root,'reporting'));await fs.writeFile(path.join(root,'reporting/__init__.py'),'');await fs.writeFile(path.join(root,'reporting/control_snapshot.py'),`import json
value={'items':[{'id':'incidents','kind':'incident','enabled':True,'togglable':False},{'id':'situation','kind':'situation','enabled':True,'togglable':False},{'id':'scheduled:job-1','kind':'scheduled','automationId':'job-1','enabled':True,'togglable':False,'reason':'automation_actions_unavailable'}],'activationRoute':None}
print(json.dumps({'schemaVersion':2,'sections':{'notifications':{'data':value,'availability':'ready','freshness':'fresh','remainingFreshMs':1000,'dataRevision':'a'*64}}}))
`);}

 const activationInstalled=typeof require('../dist/companion/control').automationNotificationProjection==='function';
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(method='GET',headers={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/notifications/sources',method,headers},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}))});req.on('error',reject);req.end();});
 try{const value=await request();assert.equal(value.status,200);assert.ok(value.body.sources.length>=3);assert.ok(value.body.sources.filter(row=>row.kind!=='scheduled').every(row=>!row.togglable));for(const row of value.body.sources.filter(row=>row.kind==='scheduled')){assert.equal(row.togglable,activationInstalled);assert.equal(row.reason,activationInstalled?'delivery_evidence_unavailable':'automation_actions_unavailable');}assert.equal((await request('POST',{'x-clawmobile-owner-flow':'v1'})).status,405);assert.equal((await request('GET',{Origin:'https://untrusted.invalid'})).status,403);assert.ok(!JSON.stringify(value).includes('authorization_ref'));console.log('R9 read: owner source projection, unknown instead of invented enabled state, native HTTP/read-only boundaries passed');}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
