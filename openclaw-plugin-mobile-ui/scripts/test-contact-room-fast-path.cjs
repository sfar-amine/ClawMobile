const assert=require('node:assert/strict');
const mod=require('../dist/contactRoomFastPath.js');
const profile=require('../dist/contactRoomProfile.js');
const number='+21610000003',agent='contacts-agenda-actions-messages';
const key=`agent:${agent}:whatsapp:direct:${number}`;
const ctx={agentId:agent,sessionKey:key,channelId:'whatsapp',messageId:'turn-1'};
const event=(content,extra={})=>({content,sessionKey:key,channel:'whatsapp',...extra});
const rooms=profile.contactRoomSession(key).rooms;
const decision=(capability,target,intent,risk='read',extra={})=>({type:'EXECUTE',capability,target,intent,risk,confirmationRequired:false,selected:{capability,target,intent,risk,confirmation_required:false},...extra});

function runner(script){const calls=[];const fn=async(message,options={})=>{calls.push({message,...options});return script(message,options,calls.length)};fn.calls=calls;return fn;}

(async()=>{
  assert.deepEqual([...rooms],['agenda','actions','messages']);
  for(const bad of [`agent:contacts-messages-agenda:whatsapp:direct:${number}`,`agent:contacts-agenda-agenda:whatsapp:direct:${number}`,`agent:contacts-maison:whatsapp:direct:${number}`])assert.equal(profile.contactRoomSession(bad),null);
  assert.equal(mod.contactRoomVerdict(decision('agenda.google_whatsapp','agenda','agenda.event.read'),rooms),'allowed');
  assert.equal(mod.contactRoomVerdict(decision('agenda.google_whatsapp','agenda','agenda.event.create','write'),rooms),'forbidden');
  assert.equal(mod.contactRoomVerdict(decision('device.assistance','','','write'),rooms),'allowed');
  assert.equal(mod.contactRoomVerdict(decision('device.modes_routines','','','write'),rooms),'allowed');
  assert.equal(mod.contactRoomVerdict(decision('notification.whatsapp.owner','whatsapp','messaging.send','external_send'),rooms),'allowed');
  const combined=profile.contactRoomSession(`agent:contacts-pulse-agenda:whatsapp:direct:${number}`).rooms;
  assert.equal(mod.contactRoomVerdict(decision('pulse.projects','pulse','project.snapshot'),combined),'outside');
  for(const forbidden of [
    decision('payment.owner_native','payment','payment.execute','transaction'),
    decision('messaging.whatsapp.owner_context','whatsapp','messaging.read'),
    decision('memory.cross_surface','memory','memory.read'),
    decision('device.remote_bridge','device','bridge.execute','write'),
    decision('agenda.google_whatsapp','agenda','agenda.event.read','read',{confirmationRequired:true}),
  ])assert.equal(mod.contactRoomVerdict(forbidden,rooms),'forbidden');

  const agenda=decision('agenda.google_whatsapp','agenda','agenda.event.read');
  let run=runner((_m,o)=>o.checkOnly?{status:'eligible',decision:agenda}:{status:'hit',text:'Demain : 09:00 — réunion, salle 4.'});
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('mon agenda demain'),ctx,run),{handled:true,text:'Demain : 09:00 — réunion, salle 4.'});
  assert.equal(run.calls.length,2);assert.equal(run.calls[0].caller,'owner');assert.equal(run.calls[0].checkOnly,true);assert.equal(run.calls[1].preparedDecision,agenda);
  assert.match(run.calls[0].originId,/^contact-room:wa-[a-f0-9]{16}:turn-1$/);

  run=runner(()=>({status:'eligible',decision:decision('payment.owner_native','payment','payment.execute','transaction')}));
  assert.match((await mod.handleContactRoomBeforeDispatch(event('paye ma facture'),ctx,run)).text,/pas autorisée/);assert.equal(run.calls.length,1);
  run=runner(()=>({status:'miss'}));assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('bonjour'),ctx,run),{handled:false});
  run=runner(()=>({status:'eligible',decision:decision('pulse.projects','pulse','project.snapshot')}));
  const combinedKey=`agent:contacts-pulse-agenda:whatsapp:direct:${number}`;
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch({content:'projet Pulse',sessionKey:combinedKey,channel:'whatsapp'},{agentId:'contacts-pulse-agenda',sessionKey:combinedKey},run),{handled:false});
  run=runner(()=>{throw Error('must not run')});
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('agenda',{isGroup:true}),ctx,run),{handled:false});
  assert.deepEqual(await mod.handleContactRoomBeforeDispatch(event('agenda'),{...ctx,agentId:'contacts'},run),{handled:false});
  assert.equal(run.calls.length,0);
  console.log('contact room fast path 20/20');
})().catch(e=>{console.error(e);process.exit(1)});
