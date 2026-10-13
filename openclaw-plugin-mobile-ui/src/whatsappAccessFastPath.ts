import crypto from "node:crypto";
import { allowlistChange, allowlistRead, ROOMS } from "./companion/whatsappAllowlist";
import { ownerWhatsAppNumbers } from "./modelFastPath";

type Event = { messageId?: string; content?: string; body?: string; channel?: string; sessionKey?: string; isGroup?: boolean };
type Context = { messageId?: string; channelId?: string; sessionKey?: string };
const SESSION = /^agent:main:whatsapp:direct:(\+?[1-9][0-9]{7,14})$/;
const LIST = /^(?:liste|affiche|montre)(?:-moi)?\s+(?:mes\s+)?contacts\s+whatsapp[.!? ]*$/i;
const GIVE = /^donne\s+[àa]\s+(.+?)\s+la\s+pi[eè]ce\s+(projet|pulse|maison)(?:\s+pour\s+(1|3|5|7)\s+jours?)?[.!? ]*$/i;
const HOUSE = /^(.+?)\s+a\s+(?:la\s+)?maison(?:\s+enti[eè]re)?[.!? ]*$/i;
const REMOVE = /^retire\s+(?:la\s+pi[eè]ce\s+|l['’]|le\s+|la\s+)?(projet|pulse|agenda|t[aâ]ches?|lignes?|m[eé]moire|actions?|messages?|maison)\s+[àa]\s+(.+?)[.!? ]*$/i;
const ROOM: Record<string,string> = { projet:"projet",pulse:"pulse",agenda:"agenda",tache:"taches",taches:"taches",ligne:"lignes",lignes:"lignes",memoire:"memoire",action:"actions",actions:"actions",message:"messages",messages:"messages",maison:"maison" };
const fold = (v:string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g," ").trim();

function eligible(event:Event,ctx:Context,owners:()=>Set<string>){
  const channel=String(event.channel||ctx.channelId||"").toLowerCase(),key=String(ctx.sessionKey||event.sessionKey||"");
  const match=SESSION.exec(key);if(channel!=="whatsapp"||!match||event.isGroup===true)return false;
  const number=match[1].startsWith("+")?match[1]:"+"+match[1];return owners().has(number);
}
function operation(event:Event,verb:string){return `wa-access:${verb}:`+crypto.createHash("sha256").update(String(event.messageId||event.content||event.body||"")).digest("hex").slice(0,32);}
function contact(items:any[],name:string){
  const wanted=fold(name);const exact=items.filter(x=>x.owner!==true&&fold(String(x.name||""))===wanted);
  if(exact.length===1)return exact[0];const prefix=items.filter(x=>x.owner!==true&&fold(String(x.name||"")).startsWith(wanted));
  return prefix.length===1?prefix[0]:null;
}

/** Owner-only WhatsApp commands. Unknown prose falls through to the existing capability-first path/model. */
export async function handleWhatsAppAccessBeforeDispatch(event:Event,ctx:Context,deps={read:allowlistRead,change:allowlistChange,owners:ownerWhatsAppNumbers}){
  if(!eligible(event,ctx,deps.owners))return {handled:false};
  const message=String(event.content||event.body||"").trim();if(!message)return {handled:false};
  const list=LIST.test(message),give=GIVE.exec(message),house=HOUSE.exec(message),remove=REMOVE.exec(message);
  if(!list&&!give&&!house&&!remove)return {handled:false};
  try{
    const result:any=await deps.read("list");const items:any[]=result.items||[];
    if(list){
      const visible=items.filter(x=>!x.owner).map(x=>`${x.name||x.contactId} : ${(x.rooms||["conversation"]).join(", ")} (${x.state})`);
      return {handled:true,text:visible.length?visible.join("\n"):"Aucun contact WhatsApp autorisé."};
    }
    const name=give?.[1]||house?.[1]||remove?.[2]||"",target=contact(items,name);
    if(!target)return {handled:true,text:"Je ne trouve pas un contact unique avec ce nom. Ouvre Accès WhatsApp pour le choisir."};
    const before:string[]=Array.isArray(target.rooms)?target.rooms:["conversation"];
    let rooms:string[];
    if(remove){
      const room=ROOM[fold(remove[1])];rooms=room==="maison"?["conversation"]:before.filter(x=>x!==room&&x!=="maison");
      if(!rooms.includes("conversation"))rooms.unshift("conversation");
    }else{
      const room=house?"maison":ROOM[fold(give![2])];rooms=room==="maison"?["maison"]:ROOMS.filter(x=>x==="conversation"||before.includes(x)||x===room);
    }
    if(give?.[3])return {handled:true,text:"La durée et l’élargissement exigent ta biométrie. Ouvre Réglages › Accès WhatsApp pour confirmer les deux ensemble."};
    if(JSON.stringify(rooms)===JSON.stringify(before))return {handled:true,text:`L’accès de ${target.name||target.contactId} est déjà à jour.`};
    const changed:any=await deps.change("patch",target.contactId,{operationId:operation(event,remove?"remove-room":"grant-room"),rooms});
    if(changed?.value?.success)return {handled:true,text:`Accès WhatsApp mis à jour pour ${target.name||target.contactId}.`};
    return {handled:true,text:"La modification n’a pas pu être terminée. Ouvre Accès WhatsApp pour voir la cause."};
  }catch(error:any){
    if(error?.message==="confirmation_required"||error?.statusCode===403)
      return {handled:true,text:"Cet élargissement exige ta biométrie. Ouvre Réglages › Accès WhatsApp pour le confirmer."};
    return {handled:true,text:`La commande Accès WhatsApp a échoué : ${String(error?.message||"cause inconnue")}.`};
  }
}
