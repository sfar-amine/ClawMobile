/** L3 native UUID observations only; Companion is the sole writer of its existing runs registry. */
import {ownerWhatsAppNumbers} from './modelFastPath';
import {recordNativeWhatsAppIngress,nativeTurnProgressState,observeNativeTurnEnd,observeNativeTurnAdoption,activeObservedNativeWhatsAppRun} from './companion/runs';
const SESSION=/^agent:main:whatsapp:direct:(\+?[1-9][0-9]{7,14})$/;
export function createNativeTurnProgressOwner(deps:{owners?:()=>Set<string>;enabled?:()=>boolean}={}){
 const owners=deps.owners||ownerWhatsAppNumbers,enabled=deps.enabled||(()=>process.env.SAMANTHA_BRAIN_ONLY==='1');
 const peer=(key:string)=>{const m=SESSION.exec(key);if(!m)return false;const n=m[1].startsWith('+')?m[1]:'+'+m[1];return owners().has(n);};
 return {
  async observe(id:string,body:any){
   if(!enabled())throw Object.assign(Error('native_turn_observation_disabled'),{statusCode:409});
   if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.sessionKey!=='string'||!peer(body.sessionKey))throw Object.assign(Error('native_turn_owner_required'),{statusCode:403});
   const allowed:Record<string,string[]>={native_ingress:['operation','sessionKey','accountId','observedMonoMs'],
    native_end:['operation','sessionKey','success'],native_adoption:['operation','sessionKey','targetRunId','observedMonoMs'],native_active:['operation','sessionKey','excludeRunId']};
   const keys=typeof body.operation==='string'&&Object.prototype.hasOwnProperty.call(allowed,body.operation)?allowed[body.operation]:undefined;
   if(!keys||Object.keys(body).some(k=>!keys.includes(k)))throw Object.assign(Error('invalid_turn_measurement'),{statusCode:400});
   if(body.operation==='native_active'&&body.excludeRunId!==undefined&&(typeof body.excludeRunId!=='string'||!/^[-A-Za-z0-9_.:]{1,160}$/.test(body.excludeRunId)))throw Object.assign(Error('invalid_turn_measurement'),{statusCode:400});
   if(body.operation==='native_active')return {success:true,state:'observed',active:await activeObservedNativeWhatsAppRun(body.sessionKey,{excludeRunId:body.excludeRunId})};
   const row=await nativeTurnProgressState(id);if(row&&row.sessionKey!==body.sessionKey)throw Object.assign(Error('turn_measurement_identity_conflict'),{statusCode:409});
   if(body.operation==='native_adoption')await observeNativeTurnAdoption(id,body.sessionKey,body.targetRunId,body.observedMonoMs);
   else if(body.operation==='native_ingress')await recordNativeWhatsAppIngress(id,body.sessionKey,body.accountId,body.observedMonoMs);
   else{
    if(typeof body.success!=='boolean')throw Object.assign(Error('invalid_turn_measurement'),{statusCode:400});
    await observeNativeTurnEnd(id,undefined,body.success,body.sessionKey);
   }
   return {success:true,state:'observed'};
  },
 };
}
