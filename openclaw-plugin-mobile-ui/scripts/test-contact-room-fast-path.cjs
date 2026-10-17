// Pièces WhatsApp d'un contact (fichier 50, #261) : SAM-MIG V2.2 — the dialogue coordinator owns the question and
// the closed grants (scope policy `contact_room:<pièces>`, tested in samantha-ui-playbooks
// tests/test_dialogue_coordinator.py ContactRoomScopeTests). This adapter only names the policy and renders the outcome.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const mod=require('../dist/contactRoomFastPath.js');
const profile=require('../dist/contactRoomProfile.js');
const number='+21610000003',agent='contacts-agenda-actions-messages';
const key=`agent:${agent}:whatsapp:direct:${number}`;
const ctx={agentId:agent,sessionKey:key,channelId:'whatsapp',messageId:'turn-1'};
const event=(content,extra={})=>({content,sessionKey:key,channel:'whatsapp',...extra});
const rooms=profile.contactRoomSession(key).rooms;

function runner(script){const calls=[];const fn=async(message,options={})=>{calls.push({message,...options});return script(message,options,calls.length)};fn.calls=calls;return fn;}

(async()=>{
  assert.deepEqual([...rooms],['agenda','actions','messages']);
  for(const bad of [`agent:contacts-messages-agenda:whatsapp:direct:${number}`,`agent:contacts-agenda-agenda:whatsapp:direct:${number}`,`agent:contacts-maison:whatsapp:direct:${number}`])assert.equal(profile.contactRoomSession(bad),null);
  assert.equal(mod.contactRoomScope(rooms),'contact_room:agenda,actions,messages');
  assert.equal(mod.contactRoomScope(profile.contactRoomSession(`agent:contacts-pulse-agenda:whatsapp:direct:${number}`).rooms),'contact_room:pulse,agenda');
  // No local verdict, no local wait: the V2.2 coordinator is the only clarification authority.
  assert.equal(mod.contactRoomVerdict,undefined);
  const src=fs.readFileSync(path.join(__dirname,'../src/contactRoomFastPath.ts'),'utf8');
  assert.doesNotMatch(src,/SurfaceClarifications|new Map|pending\.set|clarificationDecision/);

  // One admitted event: whatsapp surface, owner caller, the room policy, the contact named in the conversation.
  let run=runner(()=>({outcome:'COMPLETED',text:'Demain : 09:00 — réunion, salle 4.',handled:true}));
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('mon agenda demain',{messageId:'3EB0A',timestamp:1792165616764}),ctx,run),{handled:true,text:'Demain : 09:00 — réunion, salle 4.'});
  assert.equal(run.calls.length,1);const call=run.calls[0];
  assert.equal(call.caller,'owner');assert.equal(call.surface,'whatsapp');assert.equal(call.dialogue.mode,'turn');
  assert.equal(call.dialogue.event.surface,'whatsapp');assert.equal(call.dialogue.event.eventRef,'3EB0A');assert.equal(call.dialogue.event.admittedAt,1792165616764);
  assert.match(call.dialogue.event.conversationKey,/^contact-room:contacts-agenda-actions-messages:wa-[a-f0-9]{16}:/);
  assert.deepEqual(call.dialogue.policy,{scope:'contact_room:agenda,actions,messages',modelAllowed:false});

  // Refused by the coordinator's scope before any execution; outside (Pulse, unresolved) goes to the next owner.
  run=runner(()=>({outcome:'DENIED',reasonCode:'scope_forbidden',handled:true}));
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('paye ma facture'),ctx,run),{handled:true,text:mod.CONTACT_ROOM_REFUSAL});
  for(const reply of [{outcome:'OUTSIDE_SCOPE',reasonCode:'scope_outside',handled:true},{outcome:'UNRESOLVED',handled:true,modelAllowed:false},{outcome:'UNRESOLVED',handled:false}]){
    run=runner(()=>reply);assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('projet Pulse'),ctx,run),{handled:false});
  }
  run=runner(()=>({outcome:'TECHNICAL_FAILURE',reasonCode:'coordinator_unavailable',handled:true}));
  assert.match((await mod.handleContactRoomBeforeDispatch(event('agenda'),ctx,run)).text,/indisponible/);

  // A question and its answer: two events of the same conversation; the adapter holds nothing in between.
  run=runner((m,o,n)=>n===1?{outcome:'NEEDS_INPUT',text:'Pour quel jour ?',handled:true,question:{version:1,kind:'input',text:'Pour quel jour ?'}}:{outcome:'COMPLETED',text:'Jeudi : libre.',handled:true});
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('mon agenda',{messageId:'m1'}),ctx,run),{handled:true,text:'Pour quel jour ?'});
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('jeudi',{messageId:'m2'}),ctx,run),{handled:true,text:'Jeudi : libre.'});
  assert.equal(run.calls[0].dialogue.event.conversationKey,run.calls[1].dialogue.event.conversationKey);
  assert.notEqual(run.calls[0].dialogue.event.eventRef,run.calls[1].dialogue.event.eventRef);

  // Not a contact room turn: the runner is never called.
  run=runner(()=>{throw Error('must not run')});
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('agenda',{isGroup:true}),ctx,run),{handled:false});
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('agenda'),{...ctx,agentId:'contacts'},run),{handled:false});
  const pulseOnly=`agent:contacts-pulse:whatsapp:direct:${number}`;
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch({content:'agenda',sessionKey:pulseOnly,channel:'whatsapp'},{sessionKey:pulseOnly},run),{handled:false});
  assert.equal(run.calls.length,0);
  console.log('contact room fast path: coordinator V2.2 policy contact_room, no local clarification state');
})().catch(e=>{console.error(e);process.exit(1)});
