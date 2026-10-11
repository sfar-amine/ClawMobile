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
 let result=await api.gatewayFileList(agent);assert.deepEqual(result.items.map(x=>x.name),['AGENTS.md','SOUL.md','USER.md','IDENTITY.md']);assert.ok(!JSON.stringify(result).includes(agentList.workspace));assert.equal(calls.length,3,'list plus two root probes, issued in parallel');assert.deepEqual(calls.find(c=>c.method==='agents.files.list').params,{agentId:'main'});assert.deepEqual(calls.filter(c=>c.method==='agents.files.get').map(c=>c.params.name),['IDENTITY.md','BOOTSTRAP.md']);
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
 // Root probes run alongside the list: one owner latency, not three in sequence.
 delay=300;let began=Date.now();await api.gatewayFileList(agent);assert.ok(Date.now()-began<800,'probes must not serialize after the list');delay=0;
 // Captures of the real main session (sessions.list search agent:main:main, 10/10).
 const r20=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/r20/',name+'.json'))).response;
 const mainList=r20('sessions.files.list.main'),mainGet=r20('sessions.files.get.main'),mainSearch=r20('sessions.files.list.main-search'),mainRow=r20('sessions.list.main').sessions[0];
 assert.equal(mainRow.key,'agent:main:main');assert.equal(mainRow.isMain,true);const main={scope:'session',sessionKey:mainRow.key};
 custom=mainList;result=await api.gatewayFileList(main);const names=result.items.map(x=>x.name);
 for(const hidden of ['.git','.openclaw','context','context-backup','backup-emoji-20260924-172227','AGENTS.md.bak-ui-playbooks-20260925-020337','SOUL.md.backup-20260924-224044'])assert.ok(!names.includes(hidden),hidden);
 for(const shown of ['memory','skills','work','screenshots','ui-dumps','AGENTS.md','IDENTITY.md','SOUL.md','USER.md'])assert.ok(names.includes(shown),shown);
 assert.equal(result.items.find(x=>x.name==='screenshots').previewable,false);assert.equal(result.ownerTruncated,false);assert.deepEqual(calls.at(-1).params,{sessionKey:'agent:main:main',path:''});
 custom=mainSearch;result=await api.gatewayFileList(main,'memory',{},'2026-10');assert.equal(calls.at(-1).params.search,'2026-10');
 assert.ok(result.items.some(x=>x.path==='memory/2026-10-02.md'),'dated daily note stays visible');assert.ok(result.items.some(x=>x.path==='memory/dreaming/light/2026-10-10.md'));assert.ok(result.items.every(x=>!x.path.includes('/.dreams/')),'dot segments stay hidden');
 custom=mainGet;result=await api.gatewayFileContent(main,'IDENTITY.md');assert.equal(result.bytes.toString(),mainGet.file.content);assert.equal(result.redacted,false);custom=null;
 console.log('R20 real S24 captures: six root policy/probe supplement, exact owner params, one-RPC preview, owner search500/list250, dates, closed identity, private aliases, five image magics, 256KiB owner cap/deadline passed; main session captures (list, search, get) passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
