// Real TS -> fixed stdin IPC -> People -> private PB owners. Only fixture HOME/code/data.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {handleQaContactMediaReceived}=require('../dist/qaContactMediaOwner');
const {allowlistOwner,qaAttachmentOwner}=require('../dist/companion/whatsappAllowlist');
(async()=>{
 const pb=path.resolve(process.argv[2]||process.env.QA_PAIRED_PLAYBOOKS_ROOT||'');
 assert(await fs.stat(path.join(pb,'qa_testing/contact_input.py')),'explicit pinned playbooks fixture checkout required');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qa-media-paired-')),saved={...process.env};
 try{
  const home=path.join(dir,'fixture-home'),runtime=path.join(dir,'runtime'),shim=path.join(dir,'people-shim.py');await fs.mkdir(runtime,{recursive:true});
  // A test-only Path.home fixture is inherited by nested canonical F1 reads; shell HOME is untouched.
  await fs.writeFile(path.join(dir,'sitecustomize.py'),"import os,pathlib\npathlib.Path.home=classmethod(lambda cls: pathlib.Path(os.environ['QA_TEST_HOME']))\n");
  const owner=path.resolve(__dirname,'../../installer/termux-lite/people-trusted.py');
  await fs.writeFile(shim,`import runpy\nrunpy.run_path(${JSON.stringify(owner)},run_name='__main__')\n`);
  await fs.symlink(shim,path.join(runtime,'people-trusted.py'));
  for(const name of ['samantha-bootstrap.sh','samantha-root-guardian.sh','samantha-health-manager.sh','incident-orchestrator-worker.sh'])await fs.writeFile(path.join(runtime,name),'# fixture marker\n');
  await fs.mkdir(path.join(home,'.openclaw/tier0/bin'),{recursive:true});await fs.mkdir(path.join(home,'.openclaw/deploys'),{recursive:true});
  await fs.writeFile(path.join(home,'.openclaw/deploys/companion-deploy.lock'),'');
  await fs.writeFile(path.join(home,'.openclaw/tier0/bin/tier0-control.py'),`print(${JSON.stringify(runtime)})\n`);
  Object.assign(process.env,{QA_TEST_HOME:home,PYTHONPATH:dir+path.delimiter+pb,CLAW_UI_PLAYBOOKS_ROOT:pb,CLAW_QA_ARTIFACT_ROOT:path.join(dir,'artifacts'),SAMANTHA_WORKSPACE:path.join(home,'workspace'),SAMANTHA_PEOPLE_ROOT:path.join(home,'people'),OPENCLAW_CONFIG_PATH:path.join(home,'config.json'),SAMANTHA_PEOPLE_TRUSTED:shim});
  const setup=`import importlib.util,json,os\nfrom pathlib import Path\nfrom unittest.mock import patch\nspec=importlib.util.spec_from_file_location('fixture_people',${JSON.stringify(owner)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nnumber='+15555550123';app={'app_id':'fixture-app','app_name':'Fixture app','package':'org.example.fixture','environment':'qa','allow_writes':False}\nmeta={'state':'active','scope':'standard','scopeText':None,'expiresAt':None,'addedAt':'2026-10-18T12:00:00Z','suspendedScope':None,'personId':None,'rooms':['conversation','qa'],'qaApps':[app]}\nm.CONTACTS.mkdir(parents=True);m.CONFIG.write_text(json.dumps({'commands':{'ownerAllowFrom':['whatsapp:+15555550999']},'channels':{'whatsapp':{'allowFrom':[number]}},'bindings':[{'agentId':'contacts-qa','comment':m.ROOM_TAG+m.contact_id(number),'match':{'channel':'whatsapp','accountId':'*','peer':{'kind':'direct','id':number}}}]}))\nservice=m.Contacts(m._ExistingPeopleOwner());service.path(number).write_text(m.MARKER+'\\n'+m.canonical(meta)+'\\n'+m.END+'\\n')\nscope=service.qa_scope_read({'schema_version':1,'requester_hash':m.contact_id(number),'app_id':'fixture-app'})\nassert scope['ok'],scope\nfrom qa_testing import core\nfrom qa_testing.access_scope import private_binding\nwith private_binding(scope['scope']),patch.object(core,'_checkpoint',return_value={}):\n core.prepare({'run_id':'qa-paired','target':{'kind':'android','package':app['package'],'environment':'qa'},'mode':'smoke'})\nprint('fixture_ready')\n`;
  let setupResult=spawnSync('python3',['-c',setup],{env:process.env,encoding:'utf8',timeout:10000});assert.equal(setupResult.status,0,setupResult.stderr);assert.equal(setupResult.stdout.trim(),'fixture_ready');
  const inbound=path.join(dir,'sdk-inbound');await fs.mkdir(inbound);const source=path.join(inbound,'fixture-id.txt');await fs.writeFile(source,'Fixture application displays an account overview.');
  const ctx={channelId:'whatsapp',accountId:'fixture-account',sessionKey:'agent:contacts-qa:whatsapp:direct:+15555550123',messageId:'paired-fixture-message',senderId:'fixture-sender'};
  const event={...ctx,from:'fixture',content:'private caption never forwarded',metadata:{senderE164:'+15555550123'},media:[{path:source,messageId:ctx.messageId,contentType:'text/plain'}]};
  // SDK IO is the sole external stub: its installed public contract resolves this private fixture ID.
  const deps={people:allowlistOwner,attachment:qaAttachmentOwner,media:async()=>({resolveMediaBufferPath:async(id,subdir)=>{assert.equal(id,'fixture-id.txt');assert.equal(subdir,'inbound');return source;}})};
  const result=await handleQaContactMediaReceived(event,ctx,deps);assert.deepEqual(result,{state:'imported',reason:null,imported:1});
  const campaignPath=path.join(dir,'artifacts/runs/qa-paired/campaign.json'),run=JSON.parse(await fs.readFile(campaignPath));
  assert.equal(run.state,'DRAFT');assert.equal(run.access_scope.app_id,'fixture-app');assert(run.plan_version>0);assert(run.consolidation.dossier.version.startsWith('v-'));
  const config=JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH));config.channels.whatsapp.allowFrom=[];await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(config));
  const before=await fs.readFile(campaignPath,'utf8');const revoked=await handleQaContactMediaReceived(event,ctx,deps);assert.equal(revoked.state,'blocked');assert.equal(await fs.readFile(campaignPath,'utf8'),before);
  console.log('Actual TS/People/PB attachment owner checks passed; real private file/Q2 import and revocation, synthetic data, no S24 effects');
 }finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
