const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const realNow=Date.now;
(async()=>{
const capture=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/gateway/',name+'.json'))).response;
// Real S24 main row (sessions.list search agent:main:main) beside the limit-5 capture that lacks it.
const captured=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/r20/sessions.list.main.json'))).response,others=capture('sessions.list');
const main=captured.sessions[0];
let calls=[],clock=Date.now(),absent=false,delay=2400;Date.now=()=>clock;
require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params)=>{calls.push({method,params});await new Promise(r=>setTimeout(r,delay));
 if(method==='sessions.list'){assert.deepEqual(params,{search:'agent:main:main',limit:100});return absent?others:captured;}
 if(method==='agents.files.list')return {agentId:'main',workspace:'/fixture/workspace',files:[{name:'AGENTS.md',path:'/fixture/workspace/AGENTS.md',missing:false,size:20}]};
 if(method==='agents.files.get'){const found=params.name==='AGENTS.md';return {agentId:'main',workspace:'/fixture/workspace',file:{name:params.name,path:'/fixture/workspace/'+params.name,missing:!found,...(found?{content:'Local guidance\nCode 123456'}:{})}};}
 if(method==='sessions.files.list'){assert.equal(params.sessionKey,main.key);const entries=params.search?[{name:'2026-10-10.md',path:'memory/2026-10-10.md',kind:'file'}]:Array.from({length:250},(_,i)=>({name:'note-'+i+'.md',path:'note-'+i+'.md',kind:'file'}));return {sessionKey:params.sessionKey,root:'/fixture/workspace',files:[],browser:{path:params.path,...(params.search?{search:params.search}:{}),entries,truncated:true}};}
 assert.equal(method,'sessions.files.get');assert.equal(params.path,'memory/2026-10-10.md');assert.equal(params.sessionKey,main.key);return {sessionKey:params.sessionKey,root:'/fixture/workspace',file:{path:params.path,workspacePath:params.path,name:'2026-10-10.md',kind:'read',missing:false,contentEncoding:'utf8',previewKind:'text',content:'Local guidance\nowner@example.test'}};
};
const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const request=(url,method='GET',headers={})=>new Promise((resolve,reject)=>{const started=performance.now();const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1'+url,method,headers},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers,ms:performance.now()-started}));});req.on('error',reject);req.end();});
const ready=async url=>{for(let i=0;i<100;i++){const result=await request(url);if(result.body?.computation?.deliveryMode!=='deferred')return result;await new Promise(r=>setTimeout(r,100));}throw Error('fixture cache did not settle');};
try{
 assert.equal((await request('/files','POST')).status,403);assert.equal((await request('/files','PUT',{'x-clawmobile-owner-flow':'v1'})).status,405);for(const headers of [{origin:'https://example.test'},{referer:'https://example.test'},{'sec-fetch-site':'same-origin'}])assert.equal((await request('/files','GET',headers)).status,403);
 const cold=await request('/files?scope=agent');assert.equal(cold.status,200);assert.equal(cold.body.computation.deliveryMode,'deferred');assert.ok(cold.ms<1500);
 const list=await ready('/files?scope=agent');assert.equal(list.body.items.length,1);assert.equal(calls.filter(x=>x.method==='agents.files.list').length,1);
 const text=await ready('/files/content?scope=agent&path=AGENTS.md');assert.equal(text.headers['x-content-type-options'],'nosniff');assert.equal(text.body.text,'Local guidance\n[masqué]');
 const many=await Promise.all(Array.from({length:10},()=>request('/files?scope=session&sessionId='+main.sessionId)));assert.ok(many.every(x=>x.ms<1500));const first=await ready('/files?scope=session&sessionId='+main.sessionId);assert.equal(first.body.items.length,250);assert.equal(first.body.state,'partial');assert.equal(first.body.cursor,null);assert.equal(first.body.truncated,true);assert.equal(calls.filter(x=>x.method==='sessions.list').length,1);assert.equal(calls.filter(x=>x.method==='sessions.files.list').length,1);assert.equal((await request('/files?scope=session&cursor=anything')).status,400);
 const searches=await ready('/files?scope=session&search=2026');assert.equal(searches.body.items[0].path,'memory/2026-10-10.md');assert.equal(searches.body.search,'2026');
 const prior=calls.filter(x=>x.method==='sessions.files.get').length;const session=await ready('/files/content?scope=session&sessionId='+main.sessionId+'&path=memory/2026-10-10.md');assert.equal(session.body.text,'Local guidance\n[masqué]');assert.equal(calls.filter(x=>x.method==='sessions.files.get').length,prior+1);assert.ok(!JSON.stringify(session).includes('/fixture/workspace'));assert.ok((await request('/files/content?scope=session&sessionId='+main.sessionId+'&path=memory/2026-10-10.md')).ms<2000);
 const before=calls.length;for(const name of ['context/private.md','screenshots/probe.png','ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ.md'])assert.equal((await request('/files/content?scope=session&path='+name)).status,404);assert.equal(calls.length,before);assert.equal((await request('/files?unknown=1')).status,400);assert.equal((await request('/files?scope=session&search=a&search=b')).status,400);
 // No main row: fail closed, no fabricated key and no files RPC to another agent.
 // Underscore identities stay literal (no _→- normalizer): an unknown one is 404, never 400.
 const literal=await ready('/files?scope=session&sessionId=run_1791_ab');assert.equal(literal.status,404);
 clock+=600001;absent=true;delay=5;const filesBefore=calls.filter(x=>x.method.startsWith('sessions.files')).length;const unavailable=await ready('/files?scope=session&search=absent');assert.equal(unavailable.status,503);assert.equal(unavailable.body.error,'files_owner_unavailable');assert.equal(calls.filter(x=>x.method.startsWith('sessions.files')).length,filesBefore);
 console.log('R20 HTTP structural main-row fixture: 2.4s realistic injected RPCs, rapid deferred/cache/10-way singleflight, owner250/search, one-RPC content, literal identities, absent main no fabricated call, native guards and redaction passed; real main row from S24.');
}finally{Date.now=realNow;server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{Date.now=realNow;console.error(e);process.exitCode=1});
