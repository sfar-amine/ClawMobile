import crypto from "node:crypto";
import { SurfaceClarifications } from "./capabilityClarification";
import { contactRoomSession } from "./contactRoomProfile";
import { runModelFastPath, type FastPathResult, type RunnerOptions } from "./modelFastPath";

/**
 * Pièce « Pulse » (décision d'Amine du 12/10, fichier 52 §5).
 *
 * A WhatsApp contact holding the `pulse` room is routed by people-trusted.py to `contacts-pulse` or
 * `contacts-projet-pulse` (one concrete-peer binding, written only after the owner's biometric). For that
 * session only, the existing capability-first ingress runs on Amine's behalf, closed to the Pulse family:
 * the decision is resolved once (check), checked here, then executed as that same prepared decision
 * (re-validated by the Capability Graph). Anything else is refused before execution; `leave.request`
 * stays with Amine. No second router: the room only filters the canonical decision.
 */
export const PULSE_ROOM_AGENTS = new Set(["contacts-pulse", "contacts-projet-pulse"]);
const MAX_MESSAGE_CHARS = 4000;
export const PULSE_ROOM_REFUSAL = "Ici je ne traite que Pulse : projets, offres, congés de l'équipe et solde de congés. Pour le reste, vois directement avec Amine.";
const LEAVE_REQUEST_REFUSAL = "Une demande de congé se fait uniquement par Amine.";
export const PULSE_ROOM_HELP = "Je n'ai pas compris la demande Pulse et je ne réponds qu'avec les données de Pulse. Donne le numéro ou le nom du projet ou de l'offre, et ce que tu veux : état, équipe, consommation, forecast, congés de l'équipe.";
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

function field(decision: unknown, name: string): string {
  return decision && typeof decision === "object" ? String((decision as any)[name] ?? "") : "";
}

/** Closed scope of the room, checked on the canonical decision and on its selected candidate. */
export function pulseRoomVerdict(decision: unknown): "allowed" | "leave_request" | "outside" {
  const selected = decision && typeof decision === "object" ? (decision as any).selected : undefined;
  const routes = [field(decision, "route"), field(selected, "route")].filter(Boolean);
  const targets = [field(decision, "target"), field(selected, "target")].filter(Boolean);
  if (!targets.length || targets.some((t) => t !== "pulse") || routes.some((r) => !r.startsWith("pulse."))) return "outside";
  if ([field(decision, "intent"), field(selected, "intent")].includes("leave.request") || routes.includes("pulse.leave.request")) return "leave_request";
  if ((decision as any).confirmationRequired === true) return "outside";
  return "allowed";
}

function refusal(verdict: "leave_request" | "outside") {
  return { handled: true as const, reply: { text: verdict === "leave_request" ? LEAVE_REQUEST_REFUSAL : PULSE_ROOM_REFUSAL } };
}

const clarifications = new Map<string, { original: string; decision: Record<string, unknown>; at: number }>();
const CLARIFY_TTL_MS = 10 * 60_000;

function reply(result: FastPathResult, fallback: string) {
  return { handled: true as const, reply: { text: String(result.text || fallback).trim() || fallback } };
}

async function executeAllowed(runner: Runner, message: string, decision: Record<string, unknown>, common: RunnerOptions, conversation: string, now: () => number) {
  const done = await runner(message, { ...common, checkOnly: false, timeoutSeconds: 75, preparedDecision: decision });
  if (done.status === "hit" || done.status === "known_error") return reply(done, "Pulse n'a pas pu terminer la demande.");
  // Several matches (Amine 12/10): ask which one; the answer is resolved and checked again before running.
  if (done.status === "clarification" && done.decision && pulseRoomVerdict(done.decision) === "allowed") {
    clarifications.set(conversation, { original: message, decision: done.decision as Record<string, unknown>, at: now() });
    return reply(done, "Lequel veux-tu ?");
  }
  return { handled: true as const, reply: { text: "Pulse n'a pas pu terminer la demande. Réessaie dans un instant." } };
}

type BeforeDispatchEvent = { messageId?: string; content?: string; body?: string; channel?: string; sessionKey?: string; isGroup?: boolean };
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
  now: () => number = Date.now,
): Promise<{ handled: boolean; text?: string }> {
  const sessionKey = String(ctx?.sessionKey ?? event?.sessionKey ?? "");
  const out = await handlePulseRoomFastPath(
    // content is the sender's text; body may carry the channel envelope (« [WhatsApp …] … : »), used only as a fallback.
    { content: event?.content || event?.body, isGroup: event?.isGroup === true, sessionKey },
    { sessionKey, channel: String(event?.channel ?? ctx?.channelId ?? ""), runId: event?.messageId ?? ctx?.messageId },
    runner,
    now,
  );
  return out.handled ? { handled: true, text: out.reply?.text } : { handled: false };
}

export async function handlePulseRoomFastPath(
  event: InboundEvent,
  ctx: InboundContext,
  runner: Runner = runModelFastPath,
  now: () => number = Date.now,
): Promise<{ handled: boolean; reply?: { text: string } }> {
  const contactId = pulseRoomContact(event, ctx);
  if (!contactId) return { handled: false };
  const agent = roomAgent(event, ctx);
  const modelOr = (text: string) => (agent === "contacts-projet-pulse" ? { handled: false } : { handled: true as const, reply: { text } });
  if ((event.media?.length ?? 0) > 0 || (event.originalMedia?.length ?? 0) > 0) return modelOr(TEXT_ONLY);
  const message = (event.bodyForAgent ?? event.content ?? "").trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) return modelOr(TEXT_ONLY);
  const fallback = () => (pulseRoomMayUseModel(agent, message) ? { handled: false } : { handled: true as const, reply: { text: PULSE_ROOM_HELP } });
  const run = String(ctx.runId || event.runId || event.id || now()).slice(0, 60);
  // The requester stays visible in every resolution/execution receipt: room, contact, host run.
  const common: RunnerOptions = { surface: "whatsapp", caller: "owner", originId: `pulse-room:${contactId}:${run}`, timeoutSeconds: 30 };
  const conversation = SurfaceClarifications.idFor(String(ctx.sessionKey ?? event.sessionKey));
  try {
    for (const [key, value] of clarifications) if (now() - value.at > CLARIFY_TTL_MS) clarifications.delete(key);
    const pending = clarifications.get(conversation);
    let result: FastPathResult | undefined;
    if (pending) {
      clarifications.delete(conversation);
      const answered = await runner(message, { ...common, checkOnly: true, clarificationDecision: pending.decision, clarificationOriginalText: pending.original });
      if (answered.status !== "clarification_unrelated") result = answered;
    }
    result ??= await runner(message, { ...common, checkOnly: true });
    const decision = (result.decision && typeof result.decision === "object" ? result.decision : null) as Record<string, unknown> | null;
    if (result.status === "miss") return fallback();
    if (result.status === "error") return { handled: true, reply: { text: "Pulse est indisponible pour le moment. Réessaie dans un instant." } };
    if (!decision) return result.status === "assist" ? fallback() : refusal("outside");
    const verdict = pulseRoomVerdict(decision);
    if (verdict !== "allowed") return refusal(verdict);
    if (result.status === "clarification") {
      clarifications.set(conversation, { original: pending?.original ?? message, decision, at: now() });
      return reply(result, "Précise ta demande Pulse (nom ou numéro du projet ou de l'offre).");
    }
    if (result.status === "known_error") return reply(result, "Pulse n'a pas pu traiter la demande.");
    if (result.status === "eligible") {
      const text = String((result.resolution as any)?.text || "").trim();
      return executeAllowed(runner, pending && text ? text : message, decision, common, conversation, now);
    }
    // A Pulse request the router cannot settle deterministically: ask for the missing name instead of guessing.
    return { handled: true, reply: { text: PULSE_ROOM_HELP } };
  } catch {
    return { handled: true, reply: { text: "Pulse est indisponible pour le moment. Réessaie dans un instant." } };
  }
}
