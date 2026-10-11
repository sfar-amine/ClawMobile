// E3 / R20 lot 2: PUT /v1/files/content?scope=agent&path=NAME against the installed agents.files.* shapes.
// Real sources: agents.files.get response shape and latency (fixtures/s24-2026-10-10/gateway/agents.files.get.json,
// PR #48/#53), agents.files.set schema, handler and conflict error (fixtures/s24-2026-10-11b/e3, PR #131), payment-line
// counts per file (agent-files-facts.json). The captured contents are masked, so the bytes written here are test text
// in a temporary workspace. Privacy test lines are synthetic; historical payment-line counts do not define a guard.
const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const fixtureGet=require('../fixtures/s24-2026-10-10/gateway/agents.files.get.json');
const facts=require('../fixtures/s24-2026-10-11b/e3/agent-files-facts.json');
const handler=fs.readFileSync(path.resolve(__dirname,'../fixtures/s24-2026-10-11b/e3/agents.files.set.handler.installed.mjs.txt'),'utf8');
const schema=fs.readFileSync(path.resolve(__dirname,'../fixtures/s24-2026-10-11b/e3/agents.files.schema.installed.mjs.txt'),'utf8');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
(async()=>{
 // Captured contract the fake owner follows.
 assert.match(schema,/AgentsFilesSetParamsSchema = closedObject\(\{\s*agentId: NonEmptyString,\s*name: NonEmptyString,\s*content: Type\.String\(\),\s*expectedHash: Type\.Optional\(Sha256String\)/);
 assert.match(handler,/changed since it was read/);assert.match(handler,/type: "agent_file_conflict"/);assert.ok(!/backup|\.bak/i.test(handler),'installed handler makes no backup');
 const paymentLines=Object.fromEntries(facts.workspaceFiles.filter(f=>f.present).map(f=>[f.name,f.linesMatchingPaymentPattern]));
 assert.equal(paymentLines['AGENTS.md'],2);assert.equal(paymentLines['SOUL.md'],1);
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'agent-file-write-'));
 const old=process.env.OPENCLAW_STATE_DIR;process.env.OPENCLAW_STATE_DIR=root;
 const companion=path.join(root,'clawmobile-companion');await fsp.mkdir(companion,{recursive:true});await fsp.writeFile(path.join(companion,'runs.json'),JSON.stringify({version:1,runs:[]}));
 const workspace=path.join(root,'workspace');await fsp.mkdir(workspace);
 // Payment vocabulary stays readable. Two synthetic privacy instructions exercise the existing secret boundary.
 const agentsMd=['# AGENTS','Règle générale : répondre en français.','Ne jamais lancer un paiement sans biométrie.','Une ligne ordinaire.','Toute recharge passe par le parcours déterministe.','Ne jamais divulguer un token.','Ne jamais afficher un mot de passe.','Fin.'].join('\n')+'\n';
 const files={'AGENTS.md':agentsMd,'SOUL.md':'Samantha.\nAucun virement automatique.\n','IDENTITY.md':'Nom : Samantha\n','USER.md':'Amine.\n'};
 for(const [n,c] of Object.entries(files))await fsp.writeFile(path.join(workspace,n),c);
 let sets=0,gets=0,latency={},setFails=null,applyThenFail=false,racer=null;
 const reset=async()=>{sets=0;gets=0;latency={};setFails=null;applyThenFail=false;racer=null;for(const [n,c] of Object.entries(files))await fsp.writeFile(path.join(workspace,n),c);for(const e of await fsp.readdir(workspace))if(e.includes('.bak-samantha-'))await fsp.unlink(path.join(workspace,e));};
 const wait=ms=>ms?new Promise(r=>setTimeout(r,ms)):null;
 const gateway=require('../dist/companion/openclawAgentClient');
 gateway.callOpenClawGateway=async(method,params)=>{
  await wait(latency[method]);
  if(method==='agents.files.get'){gets++;const p=path.join(workspace,params.name);let content;try{content=await fsp.readFile(p,'utf8');}catch{return {agentId:'main',workspace,file:{name:params.name,path:p,missing:true}};}
   const r=structuredClone(fixtureGet.response);r.workspace=workspace;Object.assign(r.file,{name:params.name,path:p,size:Buffer.byteLength(content),hash:sha(content),content});return r;}
  if(method==='agents.files.set'){
   sets++;assert.deepEqual(Object.keys(params).sort(),['agentId','content','expectedHash','name']);
   if(racer){await fsp.writeFile(path.join(workspace,params.name),racer);racer=null;}
   if(setFails)throw new Error(setFails);
   const p=path.join(workspace,params.name);const currentHash=sha(await fsp.readFile(p,'utf8'));
   if(currentHash!==params.expectedHash)throw Object.assign(new Error(`agent file "${params.name}" changed since it was read`),{gatewayCode:'INVALID_REQUEST'});
   await fsp.writeFile(p,params.content);if(applyThenFail)throw new Error('socket closed after dispatch');
   return {ok:true,agentId:'main',workspace,file:{name:params.name,path:p,missing:false,size:Buffer.byteLength(params.content),hash:sha(params.content),content:params.content}};
  }
  throw new Error('unexpected '+method);
 };
 const {confirmations}=require('../dist/companion/confirmations');let record=null,consumed=0;
 confirmations.status=async id=>{if(!record||record.id!==id)throw Object.assign(new Error('confirmation_not_found'),{statusCode:404});return record;};
 confirmations.consume=async(id,expected)=>{const a=record.intent.action;if(a.type!==expected.action.type||a.reference!==expected.action.reference||a.payloadHash!==expected.action.payloadHash)throw Object.assign(new Error('confirmation_scope_mismatch'),{statusCode:409});consumed++;};
 const write=require('../dist/companion/agentFileWritePlan');
 const {route}=require('../dist/companion/server');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}');}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,method,body,headers={})=>new Promise((resolve,reject)=>{const data=body===undefined?undefined:JSON.stringify(body);const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:{'content-type':'application/json',...(data?{'content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{let t='';res.on('data',x=>t+=x);res.on('end',()=>resolve({status:res.statusCode,body:t?JSON.parse(t):null}));});req.on('error',reject);if(data)req.write(data);req.end();});
 const owner={'x-clawmobile-owner-flow':'v1'};const url='/v1/files/content?scope=agent&path=AGENTS.md';
 const readMasked=async name=>{for(let i=0;i<40;i++){const r=await request('/v1/files/content?scope=agent&path='+name,'GET');if(r.body.state==='ok')return r.body;await wait(50);}throw new Error('read never settled');};
 let n=0;const ok=(c,m)=>{assert.ok(c,m);n++;};
 try{
  // Owner boundary and the existing read-only verbs stay as they were.
  ok((await request(url,'PUT',{operationId:'x',content:'a',baseHash:'0'.repeat(64)})).status===403);
  ok((await request(url,'POST',{},owner)).status===405);ok(sets===0&&gets===0);
  // The read exposes the owner revision and masks only the two synthetic privacy lines.
  const view=await readMasked('AGENTS.md');ok(view.revision===sha(agentsMd)&&view.redacted===true,JSON.stringify(view));
  ok(view.text.split('\n').filter(l=>l==='[masqué]').length===2);
  ok(view.text.includes('Ne jamais lancer un paiement sans biométrie.')&&view.text.includes('Toute recharge passe par le parcours déterministe.'),'payment words are ordinary content');
  // Names: only the four agent files; DREAMS.md (outside the Gateway allowlist), MEMORY.md, paths and secrets refused before any read.
  for(const name of ['DREAMS.md','MEMORY.md','BOOTSTRAP.md','../AGENTS.md','TOOLS.md','.env']){await reset();const r=await request('/v1/files/content?scope=agent&path='+encodeURIComponent(name),'PUT',{operationId:'n',content:'x',baseHash:sha(agentsMd)},owner);ok(r.status===404&&gets===0,name+JSON.stringify(r));}
  for(const q of ['scope=session&path=AGENTS.md','path=AGENTS.md','scope=agent&path=AGENTS.md&sessionId=x']){await reset();ok((await request('/v1/files/content?'+q,'PUT',{operationId:'q',content:'x',baseHash:sha(agentsMd)},owner)).status===400);}
  for(const body of [{operationId:'b',content:'x'},{operationId:'b',content:'x',baseHash:'z'},{operationId:'b',content:'x',baseHash:sha(agentsMd),rename:'SOUL.md'},{operationId:'b',content:'a\0b',baseHash:sha(agentsMd)},{operationId:'b',content:'x'.repeat(256*1024+1),baseHash:sha(agentsMd)}]){await reset();const r=await request(url,'PUT',body,owner);ok([400,413].includes(r.status)&&gets===0&&sets===0,JSON.stringify(r.body));}
  // CAS precheck: stale baseHash refused before any effect, with the current revision.
  await reset();const stale=await request(url,'PUT',{operationId:'stale',content:view.text,baseHash:'f'.repeat(64)},owner);ok(stale.status===409&&stale.body.error==='file_revision_changed'&&stale.body.currentRevision===sha(agentsMd)&&sets===0);
  // Privacy guard: masked secret lines remain intact; payment words never trigger this boundary.
  const edited=view.text.replace('Une ligne ordinaire.','Une ligne modifiée depuis l\'app.');
  for(const [content,code] of [[edited.replace('[masqué]\n',''),'file_protected_lines_changed'],[edited+'[masqué]\n','file_protected_lines_changed'],[edited.replace('Fin.','mot de passe : x'),'file_content_protected'],[edited.replace('Fin.','note [masqué] ici'),'file_content_protected'],[edited.replace('[masqué]','Ne jamais lancer un paiement.'),'file_protected_lines_changed']]){
   await reset();const r=await request(url,'PUT',{operationId:'g'+n,content,baseHash:sha(agentsMd),confirmationId:'11111111-1111-4111-8111-111111111111'},owner);ok(r.status===422&&r.body.error===code&&sets===0,JSON.stringify([content.slice(-60),r.body]));
  }
  await reset();const financialWords=edited.replace('Fin.','Pays, paysage : payer la facture STEG chaque mois.');
  const vocabulary=await request(url,'PUT',{operationId:'free-vocabulary',content:financialWords,baseHash:sha(agentsMd)},owner);
  ok(vocabulary.status===403&&vocabulary.body.state==='needs_confirmation'&&sets===0,'vocabulary is accepted; actual file write still needs confirmation');
  // Biometric challenge: agent.file_write, reference = name, payloadHash = sha256(content sent).
  await reset();latency={'agents.files.get':fixtureGet._capture.latencyMs,'agents.files.set':fixtureGet._capture.latencyMs};
  const challenge=await request(url,'PUT',{operationId:'edit-1',content:edited,baseHash:sha(agentsMd)},owner);
  ok(challenge.status===403&&challenge.body.state==='needs_confirmation'&&challenge.body.scope==='agent.file_write'&&challenge.body.reference==='AGENTS.md'&&challenge.body.payloadHash===sha(edited)&&sets===0,JSON.stringify(challenge.body));
  const confirmationId='22222222-2222-4222-8222-222222222222';
  record={id:confirmationId,state:'approved',intent:{audience:'confirmation',action:{type:'agent.file_write',reference:'AGENTS.md',payloadHash:sha(edited)},presentation:{title:'t',subtitle:'s',description:'d'},origin:{channel:'samantha',id:'app'}}};
  const began=Date.now();const done=await request(url,'PUT',{operationId:'edit-1',content:edited,baseHash:sha(agentsMd),confirmationId},owner);const took=Date.now()-began;
  const written=await fsp.readFile(path.join(workspace,'AGENTS.md'),'utf8');
  ok(done.status===200&&done.body.state==='completed'&&done.body.receipt.action==='agent.file_write'&&done.body.artifact.revision===sha(written),JSON.stringify(done.body));
  ok(written.includes('Ne jamais lancer un paiement sans biométrie.')&&written.includes('Toute recharge passe par le parcours déterministe.')&&written.includes('Une ligne modifiée depuis l\'app.')&&!written.includes('[masqué]'),'ordinary payment words remain readable and privacy instructions restored verbatim');
  ok(sets===1&&consumed===1);ok(took<20000,'PUT within 20 s at captured CLI latency: '+took+' ms');
  const backups=(await fsp.readdir(workspace)).filter(e=>e.startsWith('AGENTS.md.bak-samantha-'));ok(backups.length===1&&await fsp.readFile(path.join(workspace,backups[0]),'utf8')===agentsMd&&(fs.statSync(path.join(workspace,backups[0])).mode&0o777)===0o600);
  // Backups are hidden from the file reads and the next read shows the new revision (cache dropped).
  latency={};const after=await readMasked('AGENTS.md');ok(after.revision===sha(written));
  // Same operationId: stored receipt, no second write.
  const replay=await request(url,'PUT',{operationId:'edit-1',content:edited,baseHash:sha(agentsMd),confirmationId},owner);ok(JSON.stringify(replay.body)===JSON.stringify(done.body)&&sets===1);
  // Retention: at most five backups per file.
  await reset();let base=agentsMd;
  for(let i=0;i<7;i++){const v=view.text.replace('Une ligne ordinaire.','Version '+i);record.intent.action.payloadHash=sha(v);const r=await request(url,'PUT',{operationId:'ret-'+i,content:v,baseHash:sha(base),confirmationId},owner);ok(r.body.state==='completed',JSON.stringify(r.body));base=await fsp.readFile(path.join(workspace,'AGENTS.md'),'utf8');await wait(5);}
  ok((await fsp.readdir(workspace)).filter(e=>e.startsWith('AGENTS.md.bak-samantha-')).length===5);
  // Native CAS race between the precheck and the write: the Gateway's agent_file_conflict ends as refused, no retry.
  await reset();record.intent.action.payloadHash=sha(edited);racer='Écrit par un autre propriétaire.\n';
  const race=await request(url,'PUT',{operationId:'race',content:edited,baseHash:sha(agentsMd),confirmationId},owner);ok(race.status===409&&race.body.artifact.reason==='file_revision_changed'&&sets===1,JSON.stringify(race.body));
  // Uncertain answer after the effect: one re-read proves it.
  await reset();applyThenFail=true;const unsure=await request(url,'PUT',{operationId:'unsure',content:edited,baseHash:sha(agentsMd),confirmationId},owner);ok(unsure.body.state==='completed'&&sets===1&&gets===2,JSON.stringify(unsure.body));
  // Failure without effect: re-read shows the old revision.
  await reset();setFails='gateway closed';const none=await request(url,'PUT',{operationId:'none',content:edited,baseHash:sha(agentsMd),confirmationId},owner);ok(none.status===409&&none.body.artifact.reason==='file_write_not_applied'&&sets===1,JSON.stringify(none.body));
  // Wrong confirmation binding: refused before backup and write.
  await reset();record.intent.action.payloadHash='0'.repeat(64);const wrong=await request(url,'PUT',{operationId:'wrong',content:edited,baseHash:sha(agentsMd),confirmationId},owner);
  ok(wrong.status===409&&wrong.body.artifact.reason==='confirmation_not_usable'&&sets===0&&(await fsp.readdir(workspace)).every(e=>!e.includes('.bak-samantha-')),JSON.stringify(wrong.body));
  // SOUL.md payment vocabulary remains readable; unchanged content needs no confirmation and writes nothing.
  await reset();const soul=await readMasked('SOUL.md');const same=await request('/v1/files/content?scope=agent&path=SOUL.md','PUT',{operationId:'same',content:soul.text,baseHash:soul.revision},owner);ok(same.status===200&&same.body.state==='unchanged'&&sets===0,JSON.stringify(same.body));
  // Pure merge helper keeps CRLF files intact.
  ok(write.mergeProtectedLines('a\r\nmot de passe x\r\nb','a\r\n[masqué]\r\nc')==='a\r\nmot de passe x\r\nc');
  console.log(JSON.stringify({state:'passed',assertions:n,putMs:took,backupsKept:5}));
 }finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=old;await fsp.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
