import crypto from "node:crypto";
import {FAILURE_PHRASES,hasFailurePhrase} from "./companion/receiptPresentation";
import { contactRoomSession } from "./contactRoomProfile";
import {admitNativePulseContact} from "./nativePulseAdmission";
import { admittedAtMs, dialogueTurn, dialogueHandoff, dialogueChildRequest, isQuestionReply, MAX_SPLIT_REQUESTS, splitRequests, transportEventRef,
  type DialogueReply, type DialogueRequest, type DialogueRequestContext } from "./dialogueSurface";
import { runModelFastPath, type FastPathResult, type RunnerOptions } from "./modelFastPath";

/**
 * Pièce « Pulse » (décision d'Amine du 12/10, fichier 52 §5).
 *
 * A WhatsApp contact holding the `pulse` room is routed by people-trusted.py to `contacts-pulse` or
 * `contacts-projet-pulse` (one concrete-peer binding, written only after the owner's biometric). For that
 * session only, the existing capability-first ingress runs on Amine's behalf, closed to the Pulse family:
 * the decision is resolved once and executed as that same decision by the dialogue coordinator (SAM-MIG V2.2),
 * whose closed scope policy `pulse_room` refuses anything else before execution; `leave.request` stays with
 * Amine. No second router and no local state: the room only gives the policy and the form of the replies.
 */
export const PULSE_ROOM_AGENTS = new Set(["contacts-pulse", "contacts-projet-pulse"]);
const MAX_MESSAGE_CHARS = 4000;
export const PULSE_ROOM_REFUSAL = "Ici je ne traite que Pulse : projets, offres, congés de l'équipe et solde de congés. Pour le reste, vois directement avec Amine.";
// Amine 26/10: a constraint, not a refusal. The room acts with Amine's Pulse account, so a leave
// request posted here would be recorded as Amine's leave.
export const LEAVE_REQUEST_REFUSAL = "Désolé, je ne peux pas prendre en compte les demandes de congé : j’utilise le compte Pulse d’Amine, donc un congé posé ici serait enregistré au nom d’Amine. Merci de poser ta demande de congé directement dans Pulse, avec ton propre compte.";
export const PULSE_ROOM_NOT_UNDERSTOOD = "Je n’ai pas compris ta demande Pulse. Peux-tu préciser, stp, ce que tu veux créer, modifier ou consulter (projet, offre, phase) ? Tu peux aussi essayer de la reformuler. Merci !";
export const PULSE_ROOM_HELP = "Je n'ai pas compris la demande Pulse et je ne réponds qu'avec les données de Pulse. Donne le numéro ou le nom du projet ou de l'offre, et ce que tu veux : état, équipe, consommation, forecast, congés de l'équipe.";
const PULSE_UNAVAILABLE = "Pulse est indisponible pour le moment. Réessaie dans un instant.";
const STILL_RESTARTING = "Samantha redémarre encore : rien n’a été exécuté. Renvoie ta demande dans quelques minutes, stp.";
/** Waiting bound while Samantha restarts (S24 28/10: Gateway up, interpreter ready about 1 min 40 s later). */
export const DEFER_UNTIL_READY = { windowMs: 5 * 60_000, stepMs: 5_000 };
const TEXT_ONLY = "Ici je ne lis que les messages écrits. Écris ta demande Pulse (projet, offre, congés de l'équipe).";
const CLOSED_SENTENCE=/^Pulse est fermé en ce moment \(ouvert [^()\n]{1,120}\)\. Réessaie [^\n]{1,80}$/u;
function nativeFailureText(reason:string|undefined):string {
  if(reason?.startsWith('DATA_'))return 'La configuration de confidentialité du fournisseur n’est pas vérifiée. Rien n’a été exécuté.';
  if(hasFailurePhrase(reason))return FAILURE_PHRASES.fr[reason as keyof typeof FAILURE_PHRASES.fr];
  return 'La préparation ou la vérification de cette commande n’a pas abouti. Aucun nouvel essai automatique n’est lancé.';
}

/**
 * Amine 12/10 (« il ne faut plus inventer, c'est capital ») : the model never answers about client work. In the
 * Pulse-only room it never runs at all; in the joint room (Projet Samantha + Pulse) it keeps only questions about
 * the Samantha project itself. Accents folded; words, not a classifier.
 */
const PULSE_WORDS = /\b(projets?|offres?|conges?|forecasts?|phases?|equipes?|cra|consommation|conso|evaluations?|bc|jh|clients?|affaires?|staffing|planning|budgets?|ca|rentabilite|avancement|raf|solde)\b|\b\d{5}\b/;
const SAMANTHA_WORDS = /\b(samantha|claw|companion|code|app|application|android|playbooks?|capabilit\w*|capacites?|fichiers?|documentation|doc|installeur|route|routes)\b/;
const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function pulseRoomMayUseModel(agent: string, message: string): boolean {
  if (!contactRoomSession(`agent:${agent}:whatsapp:direct:+21610000000`)?.rooms.has("projet")) return false;
  const text = fold(message);
  return SAMANTHA_WORDS.test(text) || !PULSE_WORDS.test(text);
}

type InboundEvent = {
  id?: string; runId?: string; content?: string; bodyForAgent?: string; isGroup?: boolean; senderIsOwner?: boolean;
  media?: unknown[]; originalMedia?: unknown[]; sessionKey?: string;
};
type InboundContext = { runId?: string; agentId?: string; sessionKey?: string; channel?: string; messageProvider?: string };
type Runner = (message: string, options?: RunnerOptions) => Promise<FastPathResult>;

function roomAgent(event: InboundEvent, ctx: InboundContext): string {
  return contactRoomSession(ctx.sessionKey ?? event.sessionKey)?.agent ?? "";
}

/** The room's contact from the host session key, or null when this turn is not a Pulse room DM. */
export function pulseRoomContact(event: InboundEvent, ctx: InboundContext): string | null {
  if (event.isGroup === true || event.senderIsOwner === true) return null;
  const key = String(ctx.sessionKey ?? event.sessionKey ?? "");
  const match = contactRoomSession(key);
  if (!match || !match.rooms.has("pulse") || (ctx.agentId !== undefined && ctx.agentId !== match.agent)) return null;
  const channel = String(ctx.channel || ctx.messageProvider || "whatsapp").toLowerCase();
  if (channel !== "whatsapp") return null;
  const e164 = match.e164;
  return "wa-" + crypto.createHash("sha256").update(e164).digest("hex").slice(0, 16);
}

function refusal(verdict: "leave_request" | "outside") {
  return { handled: true as const, reply: { text: verdict === "leave_request" ? LEAVE_REQUEST_REFUSAL : PULSE_ROOM_REFUSAL } };
}

type BeforeDispatchEvent = { messageId?: string; content?: string; body?: string; channel?: string; sessionKey?: string; isGroup?: boolean; timestamp?: number };
type BeforeDispatchContext = {messageId?:string;channelId?:string;sessionKey?:string;agentId?:string;
  requester?:{senderIsOwner?:unknown}};

/**
 * S24 12/10: the Gateway fires `inbound_claim` only for plugin-owned conversation bindings, so an ordinary
 * WhatsApp DM never reached the room and Sadok was answered by the model. `before_dispatch` runs for every
 * inbound message before the agent; the room key it carries is the routed agent session (owner never matches).
 */
export async function handlePulseRoomBeforeDispatch(
  event: BeforeDispatchEvent,
  ctx: BeforeDispatchContext,
  runner: Runner = runModelFastPath,
): Promise<{ handled: boolean; text?: string }> {
  // Scope comes from the SDK actor, never a phone number or the message text.
  // The owner's L3 path cannot invoke the contact's professional AI even if
  // a stale binding supplied a contact-room session key.
  if(ctx?.requester?.senderIsOwner===true||ctx?.agentId==='main')return {handled:false};
  const sessionKey = String(ctx?.sessionKey ?? event?.sessionKey ?? "");
  const out = await handlePulseRoomFastPath(
    // content is the sender's text; body may carry the channel envelope (« [WhatsApp …] … : »), used only as a fallback.
    { content: event?.content || event?.body, isGroup: event?.isGroup === true, sessionKey, timestamp: event?.timestamp },
    { sessionKey, channel: String(event?.channel ?? ctx?.channelId ?? ""), runId: event?.messageId ?? ctx?.messageId },
    runner,
  );
  return out.handled ? { handled: true, text: out.reply?.text } : { handled: false };
}

export async function handlePulseRoomFastPath(
  event: InboundEvent & { timestamp?: number },
  ctx: InboundContext,
  runner: Runner = runModelFastPath,
): Promise<{ handled: boolean; reply?: { text: string } }> {
  const contactId = pulseRoomContact(event, ctx);
  if (!contactId) return { handled: false };
  const agent = roomAgent(event, ctx);
  const modelOr = (text: string) => (agent === "contacts-projet-pulse" ? { handled: false } : { handled: true as const, reply: { text } });
  if ((event.media?.length ?? 0) > 0 || (event.originalMedia?.length ?? 0) > 0) return modelOr(TEXT_ONLY);
  const originalMessage=event.bodyForAgent ?? event.content ?? "";
  const message = originalMessage.trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) return modelOr(TEXT_ONLY);
  // The requester stays visible: the conversation is the room's host session (room, contact).
  const eventRef=transportEventRef(ctx.runId,event.runId,event.id);
  const room: RoomTurn = { agent, contactId, sessionKey: String(ctx.sessionKey ?? event.sessionKey ?? ""),
    isGroup: event.isGroup === true, admittedAt: admittedAtMs(event.timestamp) };
  const parts = splitRequests(message);
  if (parts.length === 1) {
    const one = await roomTurn(runner, room, { text: originalMessage, eventRef }, []);
    if (!one.out.handled || !one.completed || !one.resumeRequests.length || !one.requestContext) return one.out;
    return { handled: true, reply: { text: await runRequests(runner, room,
      one.resumeRequests.map(request => ({...request, requestContext: one.requestContext!})), [one.out.reply!.text]) } };
  }
  const requestContext={parentEventRef:eventRef,originalText:originalMessage};
  return { handled: true, reply: { text: await runRequests(runner, room,
    parts.map((text, n) => ({...pulseChildRequest(eventRef,text,n+1),requestContext})), []) } };
}

type RoomTurn = { agent: string; contactId: string; sessionKey: string; isGroup: boolean; admittedAt?: number };
type RoomRequest = {text:string;eventRef:string;parentEventRef?:string;ordinal?:number;requestContext?:DialogueRequestContext};
type RoomOut = { handled: boolean; reply?: { text: string } };
const MAX_ROOM_REQUESTS = 20;
export const pulseChildRequest=dialogueChildRequest;
function preservedRequests(reply:DialogueReply):{requests:DialogueRequest[];context?:DialogueRequestContext} {
  const context=reply.requestContext;
  if(!context||Object.keys(context).sort().join(',')!=='originalText,parentEventRef'||
    typeof context.parentEventRef!=='string'||!context.parentEventRef||context.parentEventRef.length>300||context.parentEventRef.startsWith('untracked:')||
    typeof context.originalText!=='string'||!context.originalText||context.originalText.length>MAX_MESSAGE_CHARS||
    !Array.isArray(reply.resumeRequests)||reply.resumeRequests.length>MAX_SPLIT_REQUESTS)return {requests:[]};
  const parts=splitRequests(context.originalText),seen=new Set<string>();
  const requests:DialogueRequest[]=[];
  for(const item of reply.resumeRequests){
    if(!item||Object.keys(item).sort().join(',')!=='eventRef,ordinal,parentEventRef,text'||
      !Number.isSafeInteger(item.ordinal)||item.ordinal<1||item.ordinal>parts.length||
      item.parentEventRef!==context.parentEventRef||item.text!==parts[item.ordinal-1]||
      item.eventRef!==pulseChildRequest(item.parentEventRef,item.text,item.ordinal).eventRef||seen.has(item.eventRef))return {requests:[]};
    seen.add(item.eventRef);requests.push(item);
  }
  return {requests,context};
}

/**
 * Several requests of one message, one after the other, each its own admitted event (`<messageId>#n`, replayable).
 * A question stops the run: the requests behind it wait in the coordinator's conversation state and come back as
 * `resumeRequests` with the turn that answers it. No local queue, no timer, no retry.
 */
async function runRequests(runner: Runner, room: RoomTurn, work: RoomRequest[], texts: string[]): Promise<string> {
  let note = "";
  let remaining=work;
  for (let i = 0; remaining.length && i < MAX_ROOM_REQUESTS; i++) {
    const [item,...siblings]=remaining;
    const queued=siblings.slice(0,MAX_SPLIT_REQUESTS).filter(w=>w.parentEventRef===item.parentEventRef)
      .map(({text,eventRef,parentEventRef,ordinal})=>({text,eventRef,parentEventRef:parentEventRef!,ordinal:ordinal!}));
    const turn = await roomTurn(runner, room, item, queued);
    texts.push(turn.out.handled ? turn.out.reply!.text : PULSE_ROOM_HELP);
    if (turn.question) {
      if (turn.queuedCount > 0) note = turn.queuedCount === 1 ? "J’ai gardé l’autre demande de ton message : je la traite dès ta réponse."
        : `J’ai gardé les ${turn.queuedCount} autres demandes de ton message : je les traite dès ta réponse.`;
      else if (siblings.length) note = "Les autres demandes de ton message n’ont pas été traitées : renvoie-les après ta réponse.";
      break;
    }
    if(!turn.completed){
      if(siblings.length)note="Les autres demandes restent en attente : le résultat de cette action doit d’abord être vérifié.";
      break;
    }
    // Only the coordinator's durable projection supplies the next work.
    // An old/invalid reply never silently promotes our local siblings.
    remaining=turn.requestContext?turn.resumeRequests.map(request=>({...request,requestContext:turn.requestContext})):[];
    if(siblings.length&&!remaining.length)note="Les autres demandes restent en attente auprès du coordinateur ; leur reprise n’est pas encore confirmée.";
  }
  const body = texts.length === 1 ? texts[0] : texts.map((text, n) => `${n + 1}) ${text}`).join("\n\n");
  return note ? `${body}\n\n${note}` : body;
}

async function roomTurn(runner: Runner, room: RoomTurn, request: RoomRequest, queuedRequests: DialogueRequest[]):
    Promise<{out:RoomOut;question:boolean;completed:boolean;queuedCount:number;resumeRequests:DialogueRequest[];requestContext?:DialogueRequestContext}> {
  const { agent, contactId, sessionKey } = room;
  const message = request.text.trim();
  let nativePulse;
  if(PULSE_ROOM_AGENTS.has(agent)&&process.env.SAMANTHA_NATIVE_PULSE_HANDOFF==='1'){
    try{nativePulse=await admitNativePulseContact({sessionKey,eventRef:request.eventRef,text:request.text,isGroup:room.isGroup,
      ...(request.requestContext?{requestContext:request.requestContext}:{})});}
    catch{return {out:{handled:true,reply:{text:'L’accès à la pièce Pulse n’est pas confirmé. Rien n’a été exécuté.'}},
      question:false,completed:false,queuedCount:0,resumeRequests:[]};}
  }
  const input={
    surface: "pulse_room" as const, graphSurface: "whatsapp",
    conversationKey: `pulse-room:${agent}:${contactId}:${sessionKey}`,
    eventRef: request.eventRef, text: nativePulse?request.text:message, caller: "owner" as const,
    ...(queuedRequests.length?{queuedRequests}:{}),
    ...(request.requestContext?{requestContext:request.requestContext}:{}),
    ...(nativePulse?{nativePulse}:{}),
    admittedAt: room.admittedAt,
    policy: { scope: "pulse_room", modelAllowed: nativePulse?false:pulseRoomMayUseModel(agent, message),
      ...(nativePulse?{deferHandoff:true}:{}) },
    timeoutSeconds: 75,
  };
  let turn=await dialogueTurn(runner,input);
  // Amine 28/10 (replaces D-B): a message received while Samantha restarts is kept and handled once she is
  // ready. The coordinator kept nothing and ran nothing; the same event is submitted again, bounded.
  for(const until=Date.now()+DEFER_UNTIL_READY.windowMs;turn.retryable===true&&Date.now()+DEFER_UNTIL_READY.stepMs<=until;){
    await new Promise(done=>setTimeout(done,DEFER_UNTIL_READY.stepMs));
    turn=await dialogueTurn(runner,input);
  }
  if(turn.retryable===true)return {out:{handled:true,reply:{text:STILL_RESTARTING}},question:false,completed:false,queuedCount:0,resumeRequests:[]};
  let reply=turn;
  if(nativePulse&&reply.pendingHandoff)reply=await dialogueHandoff(runner,input,reply.pendingHandoff.goalRef);
  const completed=reply.outcome==='COMPLETED'&&reply.replayed!==true&&!reply.pendingHandoff;
  const resume=completed?preservedRequests(reply):{requests:[]};
  return { out: roomReply(reply, !!nativePulse), question: isQuestionReply(turn),
    completed,
    queuedCount: typeof turn.queuedCount === "number" ? turn.queuedCount : 0,
    resumeRequests:resume.requests,...('context' in resume&&resume.context?{requestContext:resume.context}:{}) };
}

function roomReply(reply: DialogueReply, nativePulse: boolean): RoomOut {
  if (!reply.handled) return nativePulse?{handled:true,reply:{text:nativeFailureText(reply.reasonCode)}}:{ handled: false };
  const text = String(reply.text || "").trim();
  switch (reply.outcome) {
    case "OUTSIDE_SCOPE": return nativePulse?{handled:true,reply:{text:PULSE_ROOM_NOT_UNDERSTOOD}}:refusal("outside");
    case "DENIED":
      if(nativePulse&&hasFailurePhrase(reply.reasonCode))return {handled:true,reply:{text:nativeFailureText(reply.reasonCode)}};
      return refusal(reply.reasonCode === "scope_leave_request" ? "leave_request" : "outside");
    case "UNRESOLVED": return { handled: true, reply: { text: text || PULSE_ROOM_HELP } };
    case "FAILED":
      if(nativePulse&&hasFailurePhrase(reply.reasonCode))return {handled:true,reply:{text:nativeFailureText(reply.reasonCode)}};
      return {handled:true,reply:{text:text||PULSE_ROOM_HELP}};
    case "TECHNICAL_FAILURE":
      // S24 29/10 (recette): a creation asked out of hours came back as « n'a pas abouti ». service_closed carries
      // the canonical hours sentence built from the Pulse manifest; it is shown, never another producer text.
      if(nativePulse&&reply.reasonCode==="service_closed"&&CLOSED_SENTENCE.test(text))return {handled:true,reply:{text}};
      if(nativePulse)return {handled:true,reply:{text:nativeFailureText(reply.reasonCode)}};
      return { handled: true, reply: { text: reply.reasonCode === "coordinator_unavailable" || !text ? PULSE_UNAVAILABLE : text } };
    default: return { handled: true, reply: { text: text || PULSE_ROOM_HELP } };
  }
}
