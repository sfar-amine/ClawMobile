// Recette de formulations du 03/11 (S24) — three gaps of the typed tools, plugin side:
//  1. the shared schema offers every action's parameters, the brain passed another action's parameters to cra.status /
//     finance.ca and the owner refused the whole call (owner_input.validate_value: parameter_fields), then a 2nd try
//     (+15 s): a read now ignores what its action does not declare (traced), a write is never run with one dropped;
//  3. a room action called without a required value (offer.team without its offer) ended in the generic failure: it
//     now comes back as NEEDS_INPUT for the contact's brain to ask, nothing read or run;
//  4. the Pulse room sentences named only projects, offers and leave while the room serves CA, evaluations and CRA:
//     the subjects named are derived from the room's actions (roomActions), no right removed.
// Data: fixtures/s24-2026-11-02-pulse-room-brain (S24 capture of the Pulse projection: 14 of 37 actions, all 37 names
// and risks in provenance.all_actions; the « Recette Pulse » grant) and fixtures/s24-2026-10-25-typed-tools (compiled
// projection with the full Pulse domain: finance.ca, evaluations.team, offer.team and their schemas).
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const FIX=path.join(__dirname,'../fixtures');
const capture=JSON.parse(fs.readFileSync(path.join(FIX,'s24-2026-11-02-pulse-room-brain/pulse-tool.json'),'utf8'));
const compiled=JSON.parse(fs.readFileSync(path.join(FIX,'s24-2026-10-25-typed-tools/compiled-agent-tools.json'),'utf8'));
const grantFixture=JSON.parse(fs.readFileSync(path.join(FIX,'s24-2026-11-02-pulse-room-brain/room-grant-recette.json'),'utf8'));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'recette-formulations-'));
const views=path.join(home,'.openclaw/capability-views');fs.mkdirSync(views,{recursive:true});
fs.writeFileSync(path.join(views,'agent-tools.json'),JSON.stringify(compiled));
process.env.HOME=home;process.env.SAMANTHA_BRAIN_ONLY='1';
const guard=require('../dist/capabilityAgentGuard.js');
const typed=require('../dist/typedCapabilityTools.js');
const brain=require('../dist/roomBrain.js');
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};

// The real Pulse declarations these cases rest on.
const pulseOf=catalogue=>catalogue.tools.find(t=>t.domain==='pulse');
const decl=(name,tool=pulseOf(compiled))=>tool.actions.find(a=>a.action===name);
eq(decl('cra.status',pulseOf(capture)).params,{type:'object',properties:{},required:[],additionalProperties:false});
eq(decl('finance.ca').params,{type:'object',properties:{},required:[],additionalProperties:false});
eq(decl('offer.team').params.required,['offer_id']);
for(const name of ['cra.status','evaluations.mine','evaluations.team','finance.ca','offer.team'])
  ok(capture.provenance.all_actions.some(([action,risk])=>action===name&&risk==='read'),`${name} is a Pulse read on the S24`);
ok(!pulseOf(capture).actions.some(a=>a.action==='finance.ca'),'the 02/11 capture kept 14 of the 37 actions, without finance.ca');

// ---- fitActionParams: the action's own declaration, nothing else -------------------------------------------------
eq(typed.fitActionParams(decl('cra.status',pulseOf(capture)),{project_query:'Projet Exemple',month:'2026-10'}),
  {params:{},ignored:['project_query','month'],missing:[]});
eq(typed.fitActionParams(decl('leave.calendar'),{month:'2026-11',offer_query:'x'}),{params:{month:'2026-11'},ignored:['offer_query'],missing:[]});
eq(typed.fitActionParams(decl('offer.team'),{}),{params:{},ignored:[],missing:['offer_id']});
eq(typed.fitActionParams(decl('offer.team'),{offer_id:'  '}).missing,['offer_id'],'a blank value is not a value');
eq(typed.fitActionParams(decl('offer.team'),{offer_id:null}).missing,['offer_id']);
eq(typed.fitActionParams(decl('offer.team'),{offer_id:'4512'}),{params:{offer_id:'4512'},ignored:[],missing:[]});

(async()=>{
  // ---- 1. Owner typed tool: an undeclared parameter no longer fails a read --------------------------------------
  const helper=path.join(home,'helper.py'),helperLog=path.join(home,'helper-calls.jsonl');
  fs.writeFileSync(helper,`import sys,json\np=json.load(sys.stdin)\nopen(${JSON.stringify(helperLog)},'a').write(json.dumps(p['command'])+'\\n')\n`+
    `print(json.dumps({'state':'COMPLETED','answer':'Réponse vérifiée.','received':p['command']['params']}))\n`);
  const ctx={senderIsOwner:true,agentId:'main',sessionKey:'agent:main:companion-chat-recette',sessionId:'session-recette',
    assertInvocationCurrent(){}};
  const pulse=typed.createTypedCapabilityTools(ctx,{home,helperPath:helper}).find(t=>t.name==='samantha_pulse');
  const ownerCall=async(args,id)=>{
    assert.equal(guard.agentCapabilityHook({toolName:pulse.name,params:args,toolCallId:id},
      {requester:{senderIsOwner:true},agentId:'main',runId:'user-run-'+id,sessionKey:ctx.sessionKey,sessionId:ctx.sessionId}).block,undefined);
    const out=await pulse.execute(id,args);return {out,body:JSON.parse(out.content[0].text)};
  };
  const helperCalls=()=>fs.existsSync(helperLog)?fs.readFileSync(helperLog,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  for(const action of ['cra.status','finance.ca']){
    const before=helperCalls().length;
    const {out,body}=await ownerCall({action,params:{project_query:'Projet Exemple',month:'2026-10'}},'owner-'+action);
    ok(!out.isError,`${action} succeeds on the first call`);
    eq([body.state,body.received,body.ignoredParams],['COMPLETED',{},['project_query','month']]);
    ok(/ne les présente pas comme appliqués/.test(body.ignoredParamsNote));
    eq(helperCalls().length,before+1,'one owner invocation, no second try');
    eq(helperCalls().at(-1),{operation:'call',domain:'pulse',action,params:{}});
  }
  // A declared parameter is kept; a clean call carries no trace.
  let r=await ownerCall({action:'leave.calendar',params:{month:'2026-11',project_query:'x'}},'owner-calendar');
  eq([r.body.received,r.body.ignoredParams],[{month:'2026-11'},['project_query']]);
  r=await ownerCall({action:'finance.ca',params:{}},'owner-clean');eq([r.body.state,'ignoredParams' in r.body],['COMPLETED',false]);
  // A write is never run with a parameter dropped: nothing executed, the action's own parameters given back.
  let before=helperCalls().length;
  r=await ownerCall({action:'offer.set_status',params:{offer_id:'4512',status_value:'gagnee',month:'2026-10'}},'owner-write');
  eq([r.out.isError,r.body.state,r.body.reason,r.body.notAccepted,r.body.accepted],
    [true,'not_executed','typed_params_not_accepted',['month'],['offer_id','status_value']]);
  eq(helperCalls().length,before,'no owner process for the write');
  // confirm/cancel keep forwarding only the receipt ids.
  r=await ownerCall({action:'confirm',params:{confirmationId:'goal-1',payloadHash:'a'.repeat(64)}},'owner-confirm');
  eq(helperCalls().at(-1),{operation:'confirm',domain:'pulse',confirmationId:'goal-1',payloadHash:'a'.repeat(64)});

  // ---- Room harness: the « Recette Pulse » contact, full Pulse projection ----------------------------------------
  const contact=grantFixture.allowlist_get.contact,agent=grantFixture.routed_agent;
  const sessionKey=`agent:${agent}:whatsapp:direct:${contact.e164}`;
  const grantValue=()=>({success:true,state:'ok',receipt:null,...JSON.parse(JSON.stringify(contact)),historyCount:2});
  const roomCtx={agentId:agent,sessionKey,sessionId:'s-room',senderIsOwner:false,messageChannel:'whatsapp',assertInvocationCurrent(){}};
  function harness(replies=[],catalogue=compiled.tools){
    const reads=[],payloads=[],queue=[...replies];
    const tools=brain.createRoomTools(roomCtx,{home,catalogue,readGrant:async id=>{reads.push(id);return grantValue();},
      runTyped:async input=>{const p=JSON.parse(input);payloads.push(p);return queue.shift();}});
    return {tool:tools[0],reads,payloads};
  }
  let seq=0;
  async function roomCall(h,args){
    const id=`room-${++seq}`;
    assert.equal(guard.agentCapabilityHook({toolName:h.tool.name,params:args,toolCallId:id},
      {requester:{senderIsOwner:false},agentId:agent,runId:'room-run-'+seq,sessionKey,sessionId:'s-room'}).block,undefined);
    const out=await h.tool.execute(id,args);
    return {out,body:JSON.parse(out.content[0].text),reply:out.details?.toolText};
  }

  // ---- 1 (room). Same tolerance in the room, traced next to the delivered answer --------------------------------
  let h=harness([{state:'COMPLETED',answer:'CRA d’octobre : 4 en attente.'}]);
  r=await roomCall(h,{action:'cra.status',params:{project_query:'Projet Exemple'}});
  eq(h.payloads[0].command,{operation:'call',domain:'pulse',action:'cra.status',params:{}});
  eq([r.reply,r.body.state,r.body.ignoredParams],['CRA d’octobre : 4 en attente.','COMPLETED',['project_query']]);
  h=harness();
  r=await roomCall(h,{action:'project.phase.set_status',params:{project_query:'20495',state:'started',month:'2026-10'}});
  eq([r.body.state,r.body.reasonCode,r.body.notAccepted,r.reply,h.reads.length,h.payloads.length],
    ['NEEDS_INPUT','parameter_not_accepted',['month'],undefined,0,0],'a room write is never run with a parameter dropped');

  // ---- 3. A required value left empty becomes a question, not the generic failure ------------------------------
  for(const params of [{},{offer_id:''},{offer_id:'   '}]){
    h=harness();r=await roomCall(h,{action:'offer.team',params});
    eq([r.body.state,r.body.reasonCode,r.body.action,r.body.missing],['NEEDS_INPUT','parameter_missing','offer.team',[{name:'offer_id'}]]);
    eq([r.reply,r.out.details.needsInput,h.reads.length,h.payloads.length],[undefined,true,0,0],
      'returned to the contact\'s brain (it asks), nothing read or run');
    ok(r.body.instruction.includes('pose au contact une seule question courte')&&r.body.instruction.includes('sans proposer ni inventer'));
    ok(r.body.instruction.includes('une recherche'),'a search of the same tool may first find the value');
    ok(r.out.details.toolText===undefined&&!r.body.toolText,'never the generic « pas de résultat vérifié »');
    ok(!JSON.stringify(r.body).includes(brain.ROOM_UNVERIFIED));
  }
  // The described parameter names its description; the complete call runs as before.
  r=await roomCall(harness(),{action:'project.phase.set_status',params:{project_query:'20495'}});
  eq(r.body.missing,[{name:'state'}]);
  h=harness([{state:'COMPLETED',answer:'Équipe de l’offre 4512 : 3 personnes.'}]);
  r=await roomCall(h,{action:'offer.team',params:{offer_id:'4512'}});
  eq([r.reply,h.payloads[0].command.params,'ignoredParams' in r.body],['Équipe de l’offre 4512 : 3 personnes.',{offer_id:'4512'},false]);
  // The owner's own question (project.create, required [] in the 02/11 capture) still comes from the owner, as is.
  eq(decl('project.create',pulseOf(capture)).params.required,[]);
  h=harness([{state:'NEEDS_INPUT',answer:'Quel est le nom exact du projet ?'}],capture.tools);
  r=await roomCall(h,{action:'project.create',params:{}});
  eq([r.reply,h.payloads.length],['Quel est le nom exact du projet ?',1]);

  // ---- 4. The Pulse room names what it serves, derived from its actions ----------------------------------------
  h=harness();
  const enumerated=h.tool.parameters.properties.action.enum;
  for(const name of ['finance.ca','evaluations.mine','evaluations.team','cra.status','leave.balance','leave.calendar','offer.team'])
    ok(enumerated.includes(name),`${name} stays open in the room`);
  const full='Ici je ne traite que Pulse : projets, offres, chiffre d\'affaires, évaluations, CRA, congés de l\'équipe et solde de congés. Pour le reste, vois directement avec Amine.';
  eq(brain.roomRefusal(['pulse'],compiled.tools),full);
  eq(brain.PULSE_ROOM_REFUSAL,full,'the default names every subject');
  ok(full.startsWith('Ici je ne traite que Pulse'),'deploy-parcours.py room_outside prefix unchanged');
  r=await roomCall(h,{action:'agenda.read',params:{}});eq([r.reply,r.body.state],[full,'OUTSIDE_SCOPE']);
  ok(/chiffre d'affaires, évaluations, CRA, congés de l'équipe, solde de congés, avec phases/.test(h.tool.description),'the rules name the same subjects');
  // Only what the room exposes is named: the 02/11 capture has no finance.ca, so no « chiffre d'affaires ».
  eq(brain.roomRefusal(['pulse'],capture.tools),'Ici je ne traite que Pulse : projets, offres, évaluations, CRA, congés de l\'équipe et solde de congés. Pour le reste, vois directement avec Amine.');
  ok(!/chiffre d'affaires/.test(harness([],capture.tools).tool.description));
  // A combined room names the derived Pulse scope next to the other rooms.
  eq(brain.roomRefusal(['pulse','agenda'],compiled.tools),
    'Ici je ne traite que Pulse (projets, offres, chiffre d\'affaires, évaluations, CRA, congés de l\'équipe et solde de congés) et l’agenda d’Amine. Pour le reste, vois directement avec Amine.');

  // ---- Paired with the playbooks owner validator (owner_input.validate_value, the refusal seen on the S24) ---------
  const peer=process.env.ROOM_PLAYBOOKS_ROOT;
  if(peer){
    const cases=[['cra.status',{project_query:'Projet Exemple',month:'2026-10'}],['finance.ca',{month:'2026-10'}],
      ['leave.calendar',{month:'2026-11',project_query:'x'}],['offer.team',{}],['offer.team',{offer_id:'4512',month:'2026-10'}]]
      .map(([action,params])=>{const schema=decl(action).params;return {schema,before:params,after:typed.fitActionParams(decl(action),params).params};});
    const script='import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom skill_intelligence.owner_input import validate_value\n'+
      'def v(value,schema):\n  try: validate_value(value,schema); return "ok"\n  except ValueError as e: return e.args[0]\n'+
      'print(json.dumps([[v(c["before"],c["schema"]),v(c["after"],c["schema"])] for c in json.load(sys.stdin)]))\n';
    const out=JSON.parse(require('node:child_process').execFileSync('python3',['-c',script,peer],{input:JSON.stringify(cases),encoding:'utf8',timeout:60000}));
    eq(out,[['parameter_fields','ok'],['parameter_fields','ok'],['parameter_fields','ok'],['parameter_fields','parameter_fields'],['parameter_fields','ok']],
      'the owner refused the mixed parameters; the fitted ones pass (offer.team without its offer is asked, never sent)');
    console.log('paired with playbooks owner validator at',peer);
  }

  fs.rmSync(home,{recursive:true,force:true});
  console.log(`Recette formulations 03/11: ${checks} checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
