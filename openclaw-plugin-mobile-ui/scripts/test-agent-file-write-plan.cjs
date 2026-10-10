// Pure preparation + current fail-closed HTTP boundary; no E3 effect is qualified here.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {prepareAgentFileWrite,assertAgentFileRevision,agentFileWriteReadiness,AGENT_EDIT_NAMES}=require('../dist/companion/agentFileWritePlan');
const fixture=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../fixtures/s24-2026-10-10/gateway/agents.files.get.json'),'utf8'));
assert.equal(fixture._capture.method,'agents.files.get');assert.equal(fixture._capture.params.agentId,'main');assert.equal(fixture.response.file.name,'IDENTITY.md');
// Fixture hash is sanitized to zeros: use only its confirmed 64-character format, never
// claim hash(content) equivalence for redacted content or a successful CAS mutation.
const body={name:fixture.response.file.name,content:'Bonjour\nمرحبا\n',baseHash:fixture.response.file.hash,operationId:'e3-plan:1',confirmationId:'7ca0ae74-b942-4a80-8356-e3c5f493ebda'};
for(const name of AGENT_EDIT_NAMES){const p=prepareAgentFileWrite({...body,name});assert.deepEqual(p.action,{type:'agent.file_write',reference:name,payloadHash:crypto.createHash('sha256').update(body.content).digest('hex')});}
for(const name of ['../AGENTS.md','MEMORY.md','BOOTSTRAP.md','payments.ts','.env','credentials.json'])assert.throws(()=>prepareAgentFileWrite({...body,name}),e=>e.statusCode===404);
for(const extra of [{scope:'session'},{rename:'SOUL.md'},{delete:true},{payloadHash:'f'.repeat(64)}])assert.throws(()=>prepareAgentFileWrite({...body,...extra}),/invalid_file_write/);
assert.throws(()=>prepareAgentFileWrite({...body,confirmationId:''}),e=>e.statusCode===403);assert.throws(()=>prepareAgentFileWrite({...body,content:'x\0y'}),/invalid_file_content/);
for(const content of ['payer la facture STEG','mot de passe','confirmation bancaire'])assert.throws(()=>prepareAgentFileWrite({...body,content}),e=>e.statusCode===403);
assertAgentFileRevision(body.baseHash,body.baseHash);assert.throws(()=>assertAgentFileRevision(body.baseHash,'f'.repeat(64)),e=>e.statusCode===409);assert.equal(agentFileWriteReadiness().ready,false);
let ownerCalls=0;require('../dist/companion/openclawAgentClient').callOpenClawGateway=async()=>{ownerCalls++;throw Error('No owner call is allowed in preparation');};
const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res));
function request(headers={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/v1/files/content',method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(body));});}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{assert.equal(await request(),403);assert.equal(await request({'x-clawmobile-owner-flow':'v1'}),405);assert.equal(ownerCalls,0);console.log('E3 preparation: pure intent/hash/revision checks; existing owner guards; effects remain blocked');}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}})().catch(error=>{console.error(error.message);process.exitCode=1});
