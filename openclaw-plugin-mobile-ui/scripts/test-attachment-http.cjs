const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'attachment-http-'));process.env.OPENCLAW_STATE_DIR=path.join(root,'state');process.env.CLAWMOBILE_ATTACHMENT_DIR=path.join(root,'attachments');
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(method,url,body,headers={})=>new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{let b=[];res.on('data',x=>b.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(b).toString()}));});r.on('error',reject);r.end(body)});
 try{
 const registry=path.join(process.env.OPENCLAW_STATE_DIR,'clawmobile-companion','runs.json');fs.mkdirSync(path.dirname(registry),{recursive:true});const history=JSON.stringify({version:1,runs:[],archivedSessionIds:[],ownerConfirmations:[],paymentRequests:[],runDeletions:[]});fs.writeFileSync(registry,history);
 const headers={'content-type':'text/plain','x-clawmobile-owner-flow':'v1','x-clawmobile-operation-id':'upload-one','x-clawmobile-attachment-id':'test-file','x-clawmobile-filename':'example.txt'};
 assert.equal((await request('POST','/v1/attachments','plain text')).status,403);
 let first=JSON.parse((await request('POST','/v1/attachments','plain text',headers)).body);assert.equal(first.state,'completed');assert.equal(first.type,'file');assert.equal(first.displayName,'example.txt');assert.ok(first.receipt);
 assert.deepEqual(JSON.parse((await request('POST','/v1/attachments','plain text',headers)).body),first);
 assert.equal(fs.readFileSync(registry,'utf8'),history);
 const png=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);
 const image=await request('POST','/v1/attachments',png,{...headers,'content-type':'image/png','x-clawmobile-attachment-id':'image-ok'});assert.equal(image.status,200);assert.equal(JSON.parse(image.body).type,'image');assert.equal(fs.readFileSync(registry,'utf8'),history);
 const downloaded=await request('GET','/v1/attachments/test-file/content');assert.equal(downloaded.body,'plain text');assert.equal(downloaded.headers['x-content-type-options'],'nosniff');assert.equal(downloaded.headers['content-disposition'],'attachment');
 const old=path.join(process.env.CLAWMOBILE_ATTACHMENT_DIR,'old.img');fs.writeFileSync(old,png);assert.equal((await request('GET','/v1/attachments/old/content')).status,404);
 const collision=JSON.parse((await request('POST','/v1/attachments','different text',headers)).body);assert.equal(collision.state,'refused');assert.equal(collision.reason,'attachment_id_collision');
 const unknown=await request('POST','/v1/runs',JSON.stringify({text:'Analyze',attachments:[{id:'absent'}]}),{'content-type':'application/json'});assert.equal(unknown.status,404);assert.equal(JSON.parse(unknown.body).error,'attachment_not_found');
 const missingId=await request('POST','/v1/attachments','text',{'content-type':'text/plain','x-clawmobile-owner-flow':'v1'});assert.equal(missingId.status,400);
 const bad=JSON.parse((await request('POST','/v1/attachments','<html>not png</html>',{...headers,'content-type':'image/png','x-clawmobile-operation-id':'fake-png','x-clawmobile-attachment-id':'fake-png'})).body);assert.equal(bad.state,'refused');
 const large=await request('POST','/v1/attachments',Buffer.alloc(10*1024*1024+1),{...headers,'x-clawmobile-operation-id':'too-large','x-clawmobile-attachment-id':'too-large'});assert.equal(large.status,413);assert.equal(JSON.parse(large.body).state,'refused');
 const files=Array.from({length:6},(_,i)=>({id:'share-'+i,mimeType:'text/plain',base64:Buffer.from('text').toString('base64')}));assert.equal((await request('POST','/v1/attachments/share',JSON.stringify({files}),{...headers,'content-type':'application/json','x-clawmobile-operation-id':'share-six'})).status,413);
 console.log('Attachment owner boundary, HTTP receipt replay, MIME refusal, share limit and download headers passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
