import crypto from "node:crypto";
import { contactRoomSession } from "./contactRoomProfile";
import { admittedAtMs, dialogueTurn, transportEventRef } from "./dialogueSurface";
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
const LEAVE_REQUEST_REFUSAL = "Une demande de congé se fait uniquement par Amine.";
export const PULSE_ROOM_HELP = "Je n'ai pas compris la demande Pulse et je ne réponds qu'avec les données de Pulse. Donne le numéro ou le nom du projet ou de l'offre, et ce que tu veux : état, équipe, consommation, forecast, congés de l'équipe.";
const PULSE_UNAVAILABLE = "Pulse est indisponible pour le moment. Réessaie dans un instant.";
const TEXT_ONLY = "Ici je ne lis que les messages écrits. Écris ta demande Pulse (projet, offre, congés de l'équipe).";

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
type BeforeDispatchContext = { messageId?: string; channelId?: string; sessionKey?: string };

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
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) return modelOr(TEXT_ONLY);
  // The requester stays visible: the conversation is the room's host session (room, contact).
  const reply = await dialogueTurn(runner, {
    surface: "pulse_room", graphSurface: "whatsapp",
    conversationKey: `pulse-room:${agent}:${contactId}:${String(ctx.sessionKey ?? event.sessionKey ?? "")}`,
    eventRef: transportEventRef(ctx.runId, event.runId, event.id), text: message, caller: "owner",
    admittedAt: admittedAtMs(event.timestamp),
    policy: { scope: "pulse_room", modelAllowed: pulseRoomMayUseModel(agent, message) },
    timeoutSeconds: 75,
  });
  if (!reply.handled) return { handled: false };
  const text = String(reply.text || "").trim();
  switch (reply.outcome) {
    case "OUTSIDE_SCOPE": return refusal("outside");
    case "DENIED": return refusal(reply.reasonCode === "scope_leave_request" ? "leave_request" : "outside");
    case "UNRESOLVED": return { handled: true, reply: { text: text || PULSE_ROOM_HELP } };
    case "TECHNICAL_FAILURE":
      return { handled: true, reply: { text: reply.reasonCode === "coordinator_unavailable" || !text ? PULSE_UNAVAILABLE : text } };
    default: return { handled: true, reply: { text: text || PULSE_ROOM_HELP } };
  }
}
