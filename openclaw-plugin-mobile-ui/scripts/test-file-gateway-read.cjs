const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const capture=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/gateway/',name+'.json'))).response;
let custom=null,calls=[],delay=0,fail=false;
const agentList=capture('agents.files.list'),agentGet=capture('agents.files.get'),sessionList=capture('sessions.files.list'),sessionGet=capture('sessions.files.get');
require('../dist/companion/openclawAgentClient').callOpenClawGateway=async(method,params,options)=>{
 calls.push({method,params,options});if(delay)await new Promise(r=>setTimeout(r,delay));if(fail)throw Error('synthetic owner unavailable');
 if(custom)return structuredClone(custom);
 if(method==='agents.files.list')return structuredClone(agentList);
 if(method==='agents.files.get')return params.name==='IDENTITY.md'?structuredClone(agentGet):{agentId:'main',workspace:agentList.workspace,file:{name:params.name,path:agentList.workspace+'/'+params.name,missing:true}};
 return structuredClone(method==='sessions.files.list'?sessionList:sessionGet);
};
const api=require('../dist/companion/fileGatewayRead');
(async()=>{
 const agent={scope:'agent'},session={scope:'session',sessionKey:sessionList.sessionKey};
 let result=await api.gatewayFileList(agent);assert.deepEqual(result.items.map(x=>x.name),['AGENTS.md','SOUL.md','USER.md','IDENTITY.md']);assert.ok(!JSON.stringify(result).includes(agentList.workspace));assert.deepEqual(calls[0].params,{agentId:'main'});assert.deepEqual(calls.slice(1).map(c=>c.params.name),['IDENTITY.md','BOOTSTRAP.md']);
 result=await api.gatewayFileContent(agent,'IDENTITY.md');assert.equal(result.bytes.toString(),agentGet.file.content);
 for(const name of ['BOOTSTRAP.md','MEMORY.md'])await assert.rejects(api.gatewayFileContent(agent,name),e=>e.statusCode===404);
 for(const name of ['MEMORY.md','BOOTSTRAP.md']){custom={...agentGet,file:{...agentGet.file,name,path:agentGet.workspace+'/'+name}};assert.equal((await api.gatewayFileContent(agent,name)).bytes.toString(),agentGet.file.content);}custom=null;
 const before=calls.length;await assert.rejects(api.gatewayFileContent(agent,'DREAMS.md'),e=>e.statusCode===404);assert.equal(calls.length,before);
 result=await api.gatewayFileList(session);assert.deepEqual(result.items.map(x=>x.name),sessionList.browser.entries.map(x=>x.name));assert.deepEqual(calls.at(-1).params,{sessionKey:sessionList.sessionKey,path:''});
 const getBefore=calls.length;result=await api.gatewayFileContent(session,'IDENTITY.md');assert.equal(result.bytes.toString(),sessionGet.file.content);assert.equal(calls.length,getBefore+1,'preview must use one owner RPC');assert.deepEqual(calls.at(-1).params,{sessionKey:sessionList.sessionKey,path:'IDENTITY.md'});
 custom={...sessionList,browser:{path:'memory',search:'2026',entries:[{path:'memory/archive/2026-10-10.md',name:'2026-10-10.md',kind:'file'}],truncated:true}};
 result=await api.gatewayFileList(session,'memory',{},'2026');assert.equal(result.items[0].path,'memory/archive/2026-10-10.md');assert.equal(result.search,'2026');assert.equal(result.ownerTruncated,true);assert.equal(calls.at(-1).params.search,'2026');
 custom.browser.entries=Array.from({length:500},(_,i)=>({path:'memory/nested/note-'+i+'.md',name:'note-'+i+'.md',kind:'file'}));custom.browser.search='note';assert.equal((await api.gatewayFileList(session,'memory',{},'note')).items.length,500);
 custom.browser.entries.push({path:'memory/extra.md',name:'extra.md',kind:'file'});await assert.rejects(api.gatewayFileList(session,'memory',{},'note'),e=>e.statusCode===503);
 custom={...sessionGet,file:{...sessionGet.file,path:'memory/2026-10-10.md',workspacePath:'memory/2026-10-10.md',name:'2026-10-10.md',content:'Local note\nCode 123456'}};
 result=await api.gatewayFileContent(session,'memory/2026-10-10.md');assert.equal(result.bytes.toString(),'Local note\n[masqué]');
 for(const alias of ['context/private.md','context-backup/private.md','work/payment-log.md','credentials/private.md']){custom.file.workspacePath=alias;await assert.rejects(api.gatewayFileContent(session,'memory/2026-10-10.md'),e=>e.statusCode===404);}
 custom={...sessionGet,root:sessionGet.root+'/context'};await assert.rejects(api.gatewayFileContent(session,'IDENTITY.md'),e=>e.statusCode===404);
 const closedBefore=calls.length;for(const name of ['context/private.md','screenshots/probe.png','notes/token.txt','../private'])await assert.rejects(api.gatewayFileContent(session,name),e=>e.statusCode===404);assert.equal(calls.length,closedBefore);
 const formats=[['png',Buffer.from([137,80,78,71,13,10,26,10])],['jpeg',Buffer.from([255,216,255,224])],['gif',Buffer.from('GIF89a000')],['webp',Buffer.from('RIFF0000WEBP0000')],['avif',Buffer.from([0,0,0,20,...Buffer.from('ftypavif0000')])]];
 for(const [extension,bytes]of formats){const file='images/a.'+extension;custom={sessionKey:session.sessionKey,root:sessionGet.root,file:{path:file,workspacePath:file,name:'a.'+extension,kind:'read',missing:false,contentEncoding:'base64',previewKind:'image',mimeType:'image/'+extension,content:bytes.toString('base64')}};result=await api.gatewayFileContent(session,file);assert.equal(result.contentType,'image/'+extension);assert.deepEqual(result.bytes,bytes);}
 custom.file.content=Buffer.from('HTML pretending to be image').toString('base64');await assert.rejects(api.gatewayFileContent(session,'images/a.avif'),e=>e.statusCode===404);
 custom={...sessionGet,file:{...sessionGet.file,content:'x'.repeat(256*1024+1)}};await assert.rejects(api.gatewayFileContent(session,'IDENTITY.md'),e=>e.statusCode===404);
 custom={...sessionList,unknown:true};await assert.rejects(api.gatewayFileList(session),e=>e.statusCode===503);
 custom=null;fail=true;await assert.rejects(api.gatewayFileList(agent),e=>e.message==='file_owner_unavailable');fail=false;
 delay=30;const prior=calls.length;await assert.rejects(api.gatewayFileContent(session,'IDENTITY.md',{deadline:Date.now()-1}),e=>e.statusCode===503);assert.equal(calls.length,prior);delay=0;
 console.log('R20 real S24 captures: six root policy/probe supplement, exact owner params, one-RPC preview, owner search500/list250, dates, closed identity, private aliases, five image magics, 256KiB owner cap/deadline passed; main-session capture still required.');
})().catch(e=>{console.error(e);process.exitCode=1});
