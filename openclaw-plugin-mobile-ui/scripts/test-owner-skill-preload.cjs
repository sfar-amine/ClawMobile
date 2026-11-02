// #126: host-side skill preload for the owner main agent (S24 02/11, OpenClaw 2026.10.9: about 8 s of a 17 s first
// agenda turn were tool_search + skills_read). Skill bodies: playbooks projection, see fixtures/playbooks-2026-11-02-skill-bodies.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const cp=require('node:child_process');
const fixture=path.join(__dirname,'../fixtures/playbooks-2026-11-02-skill-bodies');
const provenance=JSON.parse(fs.readFileSync(path.join(fixture,'provenance.json'),'utf8'));
const crypto=require('node:crypto');
for(const [name,row] of Object.entries(provenance.files)){
 const body=fs.readFileSync(path.join(fixture,'skills',name,'SKILL.md'));
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),row.sha256,name+' fixture matches its provenance');
}
const home=fs.mkdtempSync(path.join(os.tmpdir(),'skill-preload-home-'));
const savedEnv={HOME:process.env.HOME,F:process.env.SAMANTHA_CONTEXT_FOUNDATION,P:process.env.SAMANTHA_SKILL_PRELOAD};
const originalExec=cp.execFileSync,originalSpawn=cp.spawn,originalSpawnSync=cp.spawnSync;
try{
 process.env.HOME=home;delete process.env.SAMANTHA_SKILL_PRELOAD;process.env.SAMANTHA_CONTEXT_FOUNDATION='0';
 assert.equal(os.homedir(),home);
 const ws=path.join(home,'.openclaw','workspace');
 fs.cpSync(path.join(fixture,'skills'),path.join(ws,'skills'),{recursive:true});
 const pre=require('../dist/ownerSkillPreload');
 const owner=require('../dist/ownerBootstrapContext');

 // 1. Matcher: one clear domain, FR / derja (Latin letters) / EN.
 const positives={
  'samantha-agenda':["Qu'est-ce que j'ai dans mon agenda demain ?",'Ajoute un rendez-vous chez le dentiste jeudi à 15h','Mes RDV de la semaine',
   'chnowa 3andi fel ajenda ghodwa','3andi maw3ed ghodwa?',"What's on my calendar tomorrow?",'Move my meeting with Sami to 4pm'],
  'samantha-factures':["Quel est l'état de mes factures",'Combien je dois à la STEG ?','Est-ce que la SONEDE a une facture impayée',
   'chnowa el fatourat elli mazelt ma khalasthomch','9addech fatoura kahraba','Do I have unpaid bills?','Show my Topnet invoice'],
  'orange-telecom':["C’est quoi mon solde Orange ?","Combien il me reste d'internet sur Orange",'Ouvre Maxit et lis mon forfait',
   '9addech 3andi rased fi orange','chouf el rasid mta3 el puce orange','What is my Orange balance?','Tunisie Telecom balance please'],
  'samantha-appareil':['Allume la torche','Mets un minuteur de 10 minutes','Active le mode ne pas déranger','Baisse le volume',
   'fi9ni 6 sbe7','sakker el bluetooth','Turn on the flashlight','Take a screenshot','Lis-moi le dernier SMS','Quel est le niveau de batterie ?'],
 };
 for(const [skill,examples] of Object.entries(positives))for(const text of examples)assert.equal(pre.matchSkill(text),skill,text);
 // Transport prefixes are not part of the request (Companion clock + session label).
 assert.equal(pre.matchSkill("[Mon 2026-11-02 09:12 GMT+1] [companion-session:agenda-x]\nQu'est-ce que j'ai dans mon agenda demain ?"),'samantha-agenda');
 assert.equal(pre.matchSkill('[Mon 2026-11-02 09:12 GMT+1] [companion-session:agenda]\nBonjour'),null,'a session label never matches');
 const negatives=[
  'Bonjour Samantha, ça va ?','Raconte-moi une blague','Merci !','Quelle heure est-il ?',"Qu'est-ce que j'ai demain ?",
  'Ouvre la pièce Pulse et propose une réunion aux membres','Pulse: quelles offres aujourd’hui ?',
  'Corrige le skill agenda','Relis le SKILL.md des factures et fais un commit','Lance la recette du déploiement de la capability agenda',
  'La facture Orange de ce mois',            // factures + orange-telecom: ambiguous
  'Mon solde Orange en wifi',                // orange-telecom + appareil: ambiguous
  'Mon solde',                               // one weak word only
  'Je veux un jus d’orange',                 // fruit: weak word only
  'Allume la lumière du salon',              // LIFX lights, not the phone
  'Envoie un SMS à Sami',                    // weak SMS only
  'rendez-vous '.repeat(120),                // too long to be a clear typed request
  '',null,undefined,42,
 ];
 for(const text of negatives)assert.equal(pre.matchSkill(text),null,String(text).slice(0,60));

 // 2. Hook output: owner main-agent turns only, per-turn field only.
 cp.execFileSync=()=>{throw Error('no process spawn on the preload path');};
 cp.spawn=cp.execFileSync;cp.spawnSync=cp.execFileSync;
 const agenda="Qu'est-ce que j'ai dans mon agenda demain ?";
 const whatsapp={agentId:'main',workspaceDir:ws,sessionKey:'agent:main:whatsapp:direct:+0',trigger:'user'};
 const companion={agentId:'main',workspaceDir:ws,sessionKey:'agent:main:companion-chat-test',trigger:'user'};
 const agendaBody=fs.readFileSync(path.join(ws,'skills/samantha-agenda/SKILL.md'),'utf8');
 for(const ctx of [whatsapp,companion,{...companion,inputProvenance:{kind:'external_user'}}]){
  const result=owner.ownerFoundationHook({prompt:agenda,messages:[]},ctx);
  assert.deepEqual(Object.keys(result),['prependContext'],ctx.sessionKey+': per-turn field only, never the system prefix');
  assert.ok(result.prependContext.startsWith('[SAMANTHA_SKILL_PRELOAD name=samantha-agenda sha256='));
  assert.ok(result.prependContext.includes('Instructions du skill samantha-agenda déjà chargées pour ce tour : ne pas les relire'));
  assert.ok(result.prependContext.includes(agendaBody.trimEnd()),'the whole installed body');
  assert.ok(result.prependContext.endsWith('[/SAMANTHA_SKILL_PRELOAD]'));
 }
 const bills=owner.ownerFoundationHook({prompt:"Quel est l'état de mes factures"},whatsapp).prependContext;
 assert.ok(bills.includes('name=samantha-factures')&&bills.includes('samantha_utility_billing'));
 assert.ok(owner.ownerFoundationHook({prompt:'Allume la torche'},companion).prependContext.includes('samantha_device_assistance'));
 assert.ok(owner.ownerFoundationHook({prompt:'9addech 3andi rased fi orange'},companion).prependContext.includes('name=orange-telecom'));
 // Contacts, Pulse/Projet rooms, other workspaces, non-owner inputs and unmatched turns: nothing.
 for(const agentId of ['contacts','contacts-projet','contacts-pulse','pulse-room-x','engineering-lite','gemini'])
  assert.equal(owner.ownerFoundationHook({prompt:agenda},{...whatsapp,agentId}),undefined,agentId);
 assert.equal(owner.ownerFoundationHook({prompt:agenda},{...whatsapp,workspaceDir:path.join(home,'other')}),undefined);
 for(const extra of [{trigger:'cron',sessionKey:'agent:main:cron:nightly'},{trigger:'heartbeat'},{sessionKey:'agent:main:subagent:x'},
  {inputProvenance:{kind:'inter_session'}},{inputProvenance:{kind:'internal_system'}}])
  assert.equal(owner.ownerFoundationHook({prompt:agenda},{...whatsapp,...extra}),undefined,JSON.stringify(extra));
 for(const prompt of ['Bonjour','La facture Orange de ce mois','Pulse : réunion demain'])
  assert.equal(owner.ownerFoundationHook({prompt},whatsapp),undefined,prompt);
 assert.equal(owner.ownerFoundationHook({},whatsapp),undefined,'no prompt: unchanged behaviour');
 process.env.SAMANTHA_SKILL_PRELOAD='0';
 assert.equal(owner.ownerFoundationHook({prompt:agenda},whatsapp),undefined,'kill switch');
 delete process.env.SAMANTHA_SKILL_PRELOAD;

 // With the foundation on: the cached system prefix is byte-identical with and without a preload.
 const split={version:2,layout:'split',sha256:'a'.repeat(64),stable_sha256:'b'.repeat(64),revision:3239,estimated_tokens:400,
  instruction:'Do not reread startup files.',skills:[{name:'samantha-agenda',description:'Agenda.',path:'skills/samantha-agenda/SKILL.md'}],
  bootstrap:'SOUL sentinel.',essential:'Essential rule sentinel.',memory:'Memory snapshot A'};
 cp.execFileSync=()=>JSON.stringify(split);
 process.env.SAMANTHA_CONTEXT_FOUNDATION='1';
 for(const ctx of [whatsapp,companion]){
  const plain=owner.ownerFoundationHook({prompt:'Bonjour'},ctx);
  const matched=owner.ownerFoundationHook({prompt:agenda},ctx);
  assert.equal(plain.prependContext,undefined);
  const {prependContext,...system}=matched;
  assert.deepEqual(system,plain,ctx.sessionKey+': prependSystemContext/appendSystemContext unchanged by the preload');
  assert.ok(prependContext.includes('name=samantha-agenda'));
  for(const value of Object.values(system))assert.ok(!value.includes('SAMANTHA_SKILL_PRELOAD')&&!value.includes(agendaBody.slice(0,200)));
 }
 process.env.SAMANTHA_CONTEXT_FOUNDATION='0';
 cp.execFileSync=()=>{throw Error('no process spawn on the preload path');};

 // 3. Size bound, identity and fail-open.
 const agendaFile=path.join(ws,'skills/samantha-agenda/SKILL.md');
 const header='---\nname: samantha-agenda\ndescription: test\n---\n';
 const exact=header+'x'.repeat(pre.SKILL_PRELOAD_MAX_BYTES-Buffer.byteLength(header));
 fs.writeFileSync(agendaFile,exact);
 assert.ok(owner.ownerFoundationHook({prompt:agenda},whatsapp).prependContext.includes(exact),'16 KiB is the bound, inclusive');
 fs.writeFileSync(agendaFile,exact+'y');
 assert.equal(owner.ownerFoundationHook({prompt:agenda},whatsapp),undefined,'a file over 16 KiB is never injected');
 fs.writeFileSync(agendaFile,'---\nname: samantha-factures\ndescription: wrong\n---\nbody\n');
 assert.equal(owner.ownerFoundationHook({prompt:agenda},whatsapp),undefined,'the file must declare the matched skill');
 fs.writeFileSync(agendaFile,header+'Updated body sentinel.\n');
 assert.ok(owner.ownerFoundationHook({prompt:agenda},whatsapp).prependContext.includes('Updated body sentinel.'),'a reinstalled skill is reread');
 fs.rmSync(path.dirname(agendaFile),{recursive:true});
 assert.equal(owner.ownerFoundationHook({prompt:agenda},whatsapp),undefined,'missing skill: fail open to nothing');
 for(const name of Object.keys(provenance.files))assert.ok(provenance.files[name].bytes<=pre.SKILL_PRELOAD_MAX_BYTES,name+' fits the bound today');

 // 4. Hot-path cost: deterministic table lookup, no model call or process (spawn stubs throw above).
 const started=process.hrtime.bigint();
 for(let i=0;i<2000;i++)pre.matchSkill(positives['orange-telecom'][i%7]);
 const ms=Number(process.hrtime.bigint()-started)/1e6;
 assert.ok(ms<1000,`2000 matches took ${ms} ms`);
}finally{
 cp.execFileSync=originalExec;cp.spawn=originalSpawn;cp.spawnSync=originalSpawnSync;
 for(const [key,name] of [['HOME','HOME'],['F','SAMANTHA_CONTEXT_FOUNDATION'],['P','SAMANTHA_SKILL_PRELOAD']]){
  if(savedEnv[key]===undefined)delete process.env[name];else process.env[name]=savedEnv[key];
 }
 fs.rmSync(home,{recursive:true,force:true});
}
console.log('PASS #126 owner skill preload: one clear typed domain per owner turn, per-turn prependContext only, stable system prefix unchanged, contacts and rooms excluded, 16 KiB bound, fail-open');
