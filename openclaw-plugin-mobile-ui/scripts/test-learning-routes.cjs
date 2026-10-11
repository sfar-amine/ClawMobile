// 38 A2 — routes owner /v1/learning/* : gardes, budget, cache, rejeu, « Ce n'est pas ça » sur le registre de runs.
// Le propriétaire playbooks (reporting.control_learning) est simulé : il rejoue la projection réelle produite
// par le module playbooks sur la capture S24 nettoyée (fixtures/s24-2026-10-11/learning/*.json).
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const FIX=path.join(__dirname,'../fixtures/s24-2026-10-11/learning');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'learning-routes-'));
 const playbooks=path.join(root,'playbooks'),log=path.join(root,'owner.log');
 await fs.mkdir(path.join(playbooks,'reporting'),{recursive:true});await fs.writeFile(path.join(playbooks,'reporting/__init__.py'),'');
 // Stub du propriétaire : latence réaliste (Python froid S24 ≈ 250 ms), journal des appels.
 await fs.writeFile(path.join(playbooks,'reporting/control_learning.py'),`import json,os,sys,time
time.sleep(float(os.environ.get('LEARNING_STUB_DELAY','0.25')))
args=sys.argv[1:];stdin=sys.stdin.read() if args and args[0]=='not-this' else ''
open(os.environ['LEARNING_STUB_LOG'],'a').write(json.dumps({'args':args,'stdin':json.loads(stdin) if stdin else None,'store':os.environ.get('SAMANTHA_IMPROVEMENT_STORE')})+'\\n')
if os.environ.get('LEARNING_STUB_FAIL'):sys.exit(3)
if args[0]=='list':print(json.dumps(json.load(open(os.environ['LEARNING_STUB_FIXTURE']))['response']))
elif args[0]=='forget':
  known=args[1]==os.environ['LEARNING_STUB_ID']
  print(json.dumps({'success':known,'state':'forgotten' if known else 'not_found','id':args[1],'receipt':{'action':'learning.forget','operationId':args[3]} if known else None}))
else:
  body=json.loads(stdin);print(json.dumps({'success':True,'state':'recorded','runId':body['runId'],'neutralized':['a'*64],'counterExample':{'state':'recorded','id':'b'*64},'roundSignal':{'state':'pending','signal':'user_correction'},'template':'recharge bonus orange {montant} dt','receipt':{'action':'learning.not_this'}}))
`);
 const synthetic=JSON.parse(await fs.readFile(path.join(FIX,'associations-synthetic.json'),'utf8'));
 const learnedId=synthetic.response.items.find(i=>i.view==='learned').id;
 Object.assign(process.env,{OPENCLAW_STATE_DIR:path.join(root,'state'),SAMANTHA_CONTROL_PLAYBOOKS:playbooks,LEARNING_STUB_LOG:log,
  LEARNING_STUB_FIXTURE:path.join(FIX,'associations-real-empty.json'),LEARNING_STUB_ID:learnedId,SAMANTHA_IMPROVEMENT_STORE:path.join(root,'improvements.db')});
 // Registre de runs existant : un run avec décision v2 (forme capturée sur le S24, runs.json 11/10), un run agent sans décision.
 await fs.mkdir(path.join(root,'state/clawmobile-companion'),{recursive:true});
 const decision={version:2,decisionId:'d'.repeat(40),requestId:'r1',type:'EXECUTE',reason:'known',surface:'samantha_android',caller:'owner',textHash:'e'.repeat(64),
  capabilityRevision:'c'.repeat(16),contractHash:'f'.repeat(64),capability:'payment.owner_native',risk:'transaction',confirmationRequired:true,
  plan:{mode:'known',target:'maxit-tunisie',intent:'telecom.orange.topup_own_number',confidence:0.99}};
 await fs.writeFile(path.join(root,'state/clawmobile-companion/runs.json'),JSON.stringify({version:1,runs:[
  {runId:'run-learned',sessionId:'s1',text:'recharge bonus Orange 12 DT',userText:'recharge bonus Orange 12 DT',acceptedAt:Date.now()-1000,state:'done',executionSource:'capability_first',decision},
  {runId:'run-agent',sessionId:'s1',text:'bonjour',acceptedAt:Date.now()-2000,state:'done',executionSource:'gateway'}],archivedSessionIds:[],paymentRequests:[],ownerConfirmations:[],runDeletions:[]}));
 const {route}=require('../dist/companion/server');const {resetLearningCache}=require('../dist/companion/learning');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,method='GET',body,headers={})=>new Promise((resolve,reject)=>{const content=body===undefined?null:JSON.stringify(body);const started=performance.now();
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{'content-type':'application/json',...(content?{'content-length':Buffer.byteLength(content)}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),ms:performance.now()-started}))});req.on('error',reject);req.end(content);});
 const calls=async()=>(await fs.readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const owner={'x-clawmobile-owner-flow':'v1'};
 try{
  // Budget 500 ms (companion-acceptance.py) avec latence de propriétaire réaliste ; lecture suivante servie par le cache court.
  const budget=0.5*1000;
  const cold=await request('/v1/learning/associations?limit=20');assert.equal(cold.status,200);assert.equal(cold.body.state,'ok');assert.deepEqual(cold.body.items,[]);
  assert.ok(cold.ms<budget,`cold ${cold.ms}ms`);
  const warm=await request('/v1/learning/associations?limit=20');assert.ok(warm.ms<50,`warm ${warm.ms}ms`);assert.equal((await calls()).length,1);
  assert.equal((await calls())[0].store,process.env.SAMANTHA_IMPROVEMENT_STORE);
  // Projection synthétique : contrat app HA6 (vue, gabarit, usages, mention paiement), jamais de chiffre.
  process.env.LEARNING_STUB_FIXTURE=path.join(FIX,'associations-synthetic.json');resetLearningCache();
  const listed=await request('/v1/learning/associations?view=learned');assert.equal(listed.status,200);
  assert.deepEqual((await calls()).at(-1).args,['list','--offset','0','--limit','50','--view','learned']);
  for(const item of listed.body.items){assert.ok(!/\d/.test(item.template));assert.ok(['candidate','learned','counter_example','default_slot','outside_catalog'].includes(item.view));}
  const learned=listed.body.items.find(i=>i.id===learnedId);assert.equal(learned.confirmationNotice.fr,'Confirmation et biométrie toujours demandées.');assert.equal(learned.requiresOwnerConfirmation,true);
  assert.equal(listed.body.policy.rememberAction,false);assert.equal(listed.body.kinds.find(k=>k.id==='outside_catalog').available,false);
  for(const bad of ['?limit=0','?limit=51','?view=remember','?offset=x','?limit=1&limit=2','?caller=owner'])assert.equal((await request('/v1/learning/associations'+bad)).status,400,bad);
  assert.equal((await request('/v1/learning/associations',undefined,undefined,{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await request('/v1/learning/associations','POST',{},owner)).status,405);
  // Oublier : en-tête propriétaire exigé, rejeu identique, identifiant inconnu 404, aucune route approve.
  const forgetUrl='/v1/learning/associations/'+learnedId+'/forget';
  assert.equal((await request(forgetUrl,'POST',{operationId:'op-1'})).status,403);
  assert.equal((await request(forgetUrl,'POST',{operationId:'op-1'},{...owner,Origin:'https://evil.invalid'})).status,403);
  const before=(await calls()).length;const forgotten=await request(forgetUrl,'POST',{operationId:'op-1'},owner);
  assert.equal(forgotten.status,200);assert.equal(forgotten.body.state,'forgotten');assert.ok(forgotten.ms<3000);
  assert.deepEqual((await request(forgetUrl,'POST',{operationId:'op-1'},owner)).body,forgotten.body);assert.equal((await calls()).length,before+1);
  assert.equal((await request('/v1/learning/associations/'+'f'.repeat(64)+'/forget','POST',{operationId:'op-2'},owner)).status,404);
  assert.equal((await request(forgetUrl,'POST',{operationId:'op 3'},owner)).status,400);
  assert.equal((await request(forgetUrl,'POST',{operationId:'op-3',requiresOwnerConfirmation:false},owner)).status,400);
  assert.equal((await request('/v1/learning/associations/'+learnedId+'/approve','POST',{operationId:'op'},owner)).status,404);
  // « Ce n'est pas ça » : le texte et la décision du run partent au propriétaire, jamais dans la réponse.
  assert.equal((await request('/v1/learning/not-this','POST',{runId:'run-learned',operationId:'nt-1'})).status,403);
  assert.equal((await request('/v1/learning/not-this','POST',{runId:'unknown',operationId:'nt-1'},owner)).status,404);
  const nt=await request('/v1/learning/not-this','POST',{runId:'run-learned',operationId:'nt-1'},owner);assert.equal(nt.status,200);assert.equal(nt.body.state,'recorded');
  const sent=(await calls()).at(-1);assert.equal(sent.args[0],'not-this');assert.equal(sent.stdin.userText,'recharge bonus Orange 12 DT');assert.equal(sent.stdin.decision.decisionId,decision.decisionId);
  const visible=JSON.stringify({...nt.body,correction:{...nt.body.correction,at:0}});assert.ok(!visible.includes('12'));assert.ok(!visible.includes('recharge'));assert.ok(!visible.includes('{montant}'));
  assert.deepEqual(nt.body.correction,{version:1,operationId:'nt-1',at:nt.body.correction.at,neutralized:1,counterExample:'recorded',roundSignal:'pending'});
  const persisted=JSON.parse(await fs.readFile(path.join(root,'state/clawmobile-companion/runs.json'),'utf8'));
  assert.equal(persisted.runs.find(r=>r.runId==='run-learned').notThis.operationId,'nt-1');
  const n=(await calls()).length;const again=await request('/v1/learning/not-this','POST',{runId:'run-learned',operationId:'nt-2'},owner);
  assert.equal(again.body.state,'already_recorded');assert.equal((await calls()).length,n);
  const agent=await request('/v1/learning/not-this','POST',{runId:'run-agent',operationId:'nt-3'},owner);assert.equal(agent.body.state,'recorded');
  assert.equal((await calls()).at(-1).stdin.decision,undefined);
  for(const bad of [{runId:'run-agent'},{runId:'run agent',operationId:'x'},{runId:'run-agent',operationId:'x',caller:'owner'}])
   assert.equal((await request('/v1/learning/not-this','POST',bad,owner)).status,400);
  // Propriétaire indisponible : 503 explicite, jamais une liste vide inventée.
  process.env.LEARNING_STUB_FAIL='1';resetLearningCache();
  const down=await request('/v1/learning/associations');assert.equal(down.status,503);assert.equal(down.body.error,'learning_owner_unavailable');
  delete process.env.LEARNING_STUB_FAIL;
  console.log(JSON.stringify({lot:'38-A2',routes:['/v1/learning/associations','/v1/learning/associations/:id/forget','/v1/learning/not-this'],coldMs:Math.round(cold.ms),warmMs:Math.round(warm.ms),budgetMs:budget}));
  console.log('learning-routes: owner guards, budget, cache, replay, not-this run marker and owner failure passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
