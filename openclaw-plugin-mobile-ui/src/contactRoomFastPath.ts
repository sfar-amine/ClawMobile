import crypto from "node:crypto";
import { contactRoomSession, type ContactRoom } from "./contactRoomProfile";
import { admittedAtMs, dialogueTurn, transportEventRef } from "./dialogueSurface";
import { runModelFastPath, type FastPathResult, type RunnerOptions } from "./modelFastPath";
import { allowlistOwner } from "./companion/whatsappAllowlist";

type Event = { messageId?: string; content?: string; body?: string; sessionKey?: string; channel?: string; isGroup?: boolean; timestamp?: number; media?:unknown[]; originalMedia?:unknown[] };
type Context = { messageId?: string; sessionKey?: string; channelId?: string; agentId?: string };
type Runner = (message: string, options?: RunnerOptions) => Promise<FastPathResult>;
const ACTIVE = new Set<ContactRoom>(["agenda", "actions", "messages", "qa"]);
const ROOM_ORDER: ContactRoom[] = ["projet", "pulse", "agenda", "actions", "messages", "qa"];
export const CONTACT_ROOM_REFUSAL = "Cette demande n’est pas autorisée dans les pièces qui te sont ouvertes.";
const UNAVAILABLE = "Cette pièce est momentanément indisponible. Réessaie dans un instant.";
const TEXT_ONLY = "Écris la demande en texte, en moins de 4 000 caractères.";

/**
 * Pièces WhatsApp d'un contact (fichier 50) : agenda en lecture, actions de l'appareil, message au nom d'Amine.
 * SAM-MIG V2.2 : the dialogue coordinator owns the question, the wait and the resumption; the closed grants are its
 * scope policy `contact_room:<pièces>` (playbooks skill_intelligence/dialogue/transition.py). No local state and no
 * second clarification authority here: this adapter only names the policy and renders the outcome.
 */
export function contactRoomScope(rooms: ReadonlySet<ContactRoom>): string {
  return "contact_room:" + ROOM_ORDER.filter(room => rooms.has(room)).join(",");
}

function response(text: string) { return { handled: true as const, text }; }

export async function handleContactRoomBeforeDispatch(event: Event, ctx: Context, runner: Runner = runModelFastPath) {
  if (event.isGroup === true) return { handled: false };
  const key = String(ctx.sessionKey || event.sessionKey || "");
  const profile = contactRoomSession(key);
  if (!profile || (ctx.agentId && ctx.agentId !== profile.agent) || ![...profile.rooms].some(r => ACTIVE.has(r))) return { handled: false };
  if (String(event.channel || ctx.channelId || "whatsapp").toLowerCase() !== "whatsapp") return { handled: false };
  if(profile.rooms.has('qa')&&((event.media?.length??0)>0||(event.originalMedia?.length??0)>0))
    return response('Je ne peux pas encore importer cette pièce jointe dans les tests auto. Aucun fichier n’a été lu.');
  const message = String(event.content || event.body || "").trim();
  if (!message || message.length > 4000) return response(TEXT_ONLY);
  const contactId = "wa-" + crypto.createHash("sha256").update(profile.e164).digest("hex").slice(0, 16);
  const eventRef=transportEventRef(event.messageId,ctx.messageId);
  let qaContext:Record<string,unknown>|undefined;
  if(profile.rooms.has('qa')){
    // A session name is not an authorization. Re-read the canonical active contact/app grants.
    try{
      const authority=await allowlistOwner('qa-ingress-read',{requester_hash:contactId},false,true);
      if(authority.ok!==true||!Array.isArray(authority.grants)||authority.grants.length<1||authority.grants.length>12)return response(CONTACT_ROOM_REFUSAL);
      qaContext={schema_version:1,access_class:'qa_room',requester_hash:contactId,
        thread_ref:'contact-room:'+crypto.createHash('sha256').update(key).digest('hex'),
        conversation_kind:'direct',transport_event_id:crypto.createHash('sha256').update(eventRef).digest('hex'),
        owner:false,grants:authority.grants};
    }catch{return response(UNAVAILABLE);}
  }
  const reply = await dialogueTurn(runner, {
    surface: "whatsapp", graphSurface: "whatsapp",
    conversationKey: `contact-room:${profile.agent}:${contactId}:${key}`,
    eventRef, text: message, caller: qaContext?"trusted":"owner",qaContext,
    admittedAt: admittedAtMs(event.timestamp),
    policy: { scope: contactRoomScope(profile.rooms), modelAllowed: false },
    timeoutSeconds: qaContext?10:75,
  });
  if (!reply.handled) return qaContext?response(CONTACT_ROOM_REFUSAL):{ handled: false };
  const text = String(reply.text || "").trim();
  switch (reply.outcome) {
    // A Pulse request in a room that includes Pulse, or an unresolved one: the next owner (Pulse room, contact agent).
    case "OUTSIDE_SCOPE": case "UNRESOLVED": return qaContext?response(CONTACT_ROOM_REFUSAL):{ handled: false };
    case "DENIED": return response(CONTACT_ROOM_REFUSAL);
    case "TECHNICAL_FAILURE": return response(reply.reasonCode === "coordinator_unavailable" || !text ? UNAVAILABLE : text);
    default: return response(text || "La demande a été traitée.");
  }
}
