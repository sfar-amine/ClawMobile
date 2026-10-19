// Synthetic credentials must use the private pipe, never argv, event or public result.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {runModelFastPath}=require('../dist/modelFastPath.js');
const {normalizeQaApps,qaRoomsConfirmationHash}=require('../dist/companion/whatsappAllowlist.js');
const {spawnSync}=require('node:child_process');
const {handleContactRoomBeforeDispatch}=require('../dist/contactRoomFastPath.js');
const context={schema_version:1,access_class:'qa_room',requester_hash:'wa-0123456789abcdef',
 thread_ref:'contact-room:fixture',conversation_kind:'direct',transport_event_id:'fixture-1',owner:false,
 grants:[{app_id:'demo',app_name:'Demo QA',package:'test.claw.qa.fixture',environment:'recette',allow_writes:false,
 grant_revision:'a'.repeat(64),expires_at:null}]};
const secret='SYNTHETIC_CREDENTIAL_SENTINEL_Q13';
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qa-private-ingress-'));
 try{
  const helper=path.join(directory,'helper.py');
  fs.writeFileSync(helper,`import json,os,sys\npayload=json.load(sys.stdin)\nassert os.environ.get('SAMANTHA_QA_INPUT_FD')=='0'\nassert 'SAMANTHA_QA_CONTEXT_FD' not in os.environ\nassert ${JSON.stringify(secret)} not in json.dumps(sys.argv)\nassert payload['user_input']==${JSON.stringify(secret)}\nassert payload['context']['owner'] is False\nprint(json.dumps({'outcome':'COMPLETED','text':'Accusé neutre','handled':True,'modelAllowed':False}))\n`);
  const result=await runModelFastPath(secret,{helperPath:helper,qaContext:context,surface:'whatsapp',caller:'trusted',
    dialogue:{mode:'turn',event:{eventRef:'fixture-1'},policy:{scope:'contact_room:qa',modelAllowed:false}}});
  assert.equal(result.outcome,'COMPLETED');assert.equal(result.text,'Accusé neutre');
  assert.ok(!JSON.stringify(result).includes(secret));
  const app={app_id:'demo',app_name:'Demo QA',package:'test.claw.qa.fixture',environment:'recette',allow_writes:false};
  assert.deepEqual(normalizeQaApps([{...app,app_id:'z'},app]),[app,{...app,app_id:'z'}]);
  for(const apps of [[app,app],[{...app,allow_writes:1}],[{...app,package:'com.android.settings'}],
    [{...app,environment:'production admin'}],[{...app,app_name:'OTP 123456'}],[{...app,token:'extra'}]])
    assert.throws(()=>normalizeQaApps(apps));
  const samples=[app,{...app,app_id:'z',app_name:'Démo QA ✨'}];
  const paired=spawnSync('python3',['-c',`import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('people',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nv=json.load(sys.stdin);print(json.dumps({'apps':m.normalize_qa_apps(v['apps']),'hash':m.qa_rooms_confirmation_hash(v['number'],v['rooms'],v['apps'])},ensure_ascii=False))`,path.resolve(__dirname,'../../installer/termux-lite/people-trusted.py')],
    {input:JSON.stringify({apps:samples,number:'+21610000009',rooms:['conversation','qa']}),encoding:'utf8',timeout:3000,maxBuffer:32768});
  assert.equal(paired.status,0);const python=JSON.parse(paired.stdout);
  assert.deepEqual(python.apps,normalizeQaApps(samples));
  assert.equal(python.hash,qaRoomsConfirmationHash('+21610000009',['conversation','qa'],samples));
  const key='agent:contacts-qa:whatsapp:direct:+21610000009';
  const media=await handleContactRoomBeforeDispatch({sessionKey:key,channel:'whatsapp',media:[{path:'/untrusted/private/path'}],body:'[media attached: /untrusted/private/path]'},
    {sessionKey:key,agentId:'contacts-qa'},()=>{throw new Error('must not fall through');});
  assert.equal(media.handled,true);assert.match(media.text,/Aucun fichier n’a été lu/);
  const authorityHelper=path.join(directory,'authority.py');
  const contactId='wa-'+crypto.createHash('sha256').update('+21610000009').digest('hex').slice(0,16);
  fs.writeFileSync(authorityHelper,`import json,sys\nv=json.load(sys.stdin)\nassert sys.argv[1:]==['qa-ingress-read']\nassert v=={'requester_hash':${JSON.stringify(contactId)}}\nprint(json.dumps({'ok':True,'grants':${JSON.stringify(context.grants).replaceAll('false','False').replaceAll('null','None')}}))\n`);
  const previousAuthority=process.env.SAMANTHA_PEOPLE_TRUSTED;
  try{
   process.env.SAMANTHA_PEOPLE_TRUSTED=authorityHelper;
   let calls=0;
   const blocked=await handleContactRoomBeforeDispatch({sessionKey:key,channel:'whatsapp',content:'Un smoke',messageId:'fixture-no-fallback'},
    {sessionKey:key,agentId:'contacts-qa'},async(message,options)=>{
     calls++;assert.equal(options.caller,'trusted');assert.equal(options.qaContext.requester_hash,contactId);
     return {outcome:'UNRESOLVED',modelAllowed:true,handled:false};
    });
   assert.equal(calls,1);assert.equal(blocked.handled,true);assert.match(blocked.text,/pas autorisée/);
   // Actual subprocess latency: a 2 s authority read plus an unresponsive
   // helper must stay below the complete 15 s ingress budget, without retry.
   fs.writeFileSync(authorityHelper,fs.readFileSync(authorityHelper,'utf8').replace('import json,sys','import json,sys,time\ntime.sleep(2)'));
   const slowHelper=path.join(directory,'slow.py');
   fs.writeFileSync(slowHelper,'import time\ntime.sleep(30)\n');
   const started=performance.now();let helperCalls=0;
   const timed=await handleContactRoomBeforeDispatch({sessionKey:key,channel:'whatsapp',content:'Un smoke',messageId:'fixture-budget'},
    {sessionKey:key,agentId:'contacts-qa'},async(message,options)=>{
     helperCalls++;return runModelFastPath(message,{...options,helperPath:slowHelper});
    });
   const elapsed=performance.now()-started;
   assert.equal(helperCalls,1);assert.equal(timed.handled,true);
   assert.ok(elapsed>=12500&&elapsed<15000,`QA ingress budget ${Math.round(elapsed)} ms`);
  }finally{if(previousAuthority===undefined)delete process.env.SAMANTHA_PEOPLE_TRUSTED;else process.env.SAMANTHA_PEOPLE_TRUSTED=previousAuthority;}
  console.log('QA private ingress: raw credential only in host stdin, closed grants, public acknowledgement only');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(()=>{console.error('QA private ingress contract failed');process.exitCode=1;});
