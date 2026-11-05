/**
 * Amine 05/11 — a WhatsApp message sent to a room contact on Amine's behalf (owner send through people-trusted.py, or
 * the outcome notice of a room send approval) is invisible to that contact's room model: OpenClaw mirrors the `send`
 * into another session and strips `delivery-mirror` messages from model replay. When the contact answers « ok », the
 * room brain must know what it answers.
 *
 * This Gateway method queues ONE next-turn context injection on the contact's existing room session through the public
 * SDK owner (`api.session.workflow.enqueueNextTurnInjection`, persisted in the session entry, deduplicated on its
 * idempotency key, bounded and expiring, drained into the prompt context of that session's next turn). No store of
 * ours, no new session: the room is read from the people-trusted grant (allowlistRead get, the same read as the room
 * brain) and routed exactly like people-trusted.py room_agent (roomAgentFor). Closed results, never a send.
 */
import {createHash} from "node:crypto";
import {allowlistRead} from "./companion/whatsappAllowlist";
import {contactRoomSession, roomAgentFor} from "./contactRoomProfile";

export const ROOM_OWNER_SENT_METHOD = "samantha.room.owner_sent";
export const OWNER_SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OWNER_SENT_MAX_TEXT = 4000;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const MESSAGE_ID = /^[A-Za-z0-9_.:@+=|-]{1,200}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const LABELS = {
  owner_via_samantha: "Message envoyé par Amine via Samantha",
  room_send_outcome: "Message envoyé au contact par Samantha",
} as const;
export type OwnerSentSource = keyof typeof LABELS;
const REQUIRED = ["e164", "messageId", "at", "text"], OPTIONAL = ["source", "sessionKey"];

export type OwnerSentInput = {e164: string; messageId: string; at: string; text: string; source: OwnerSentSource; sessionKey?: string};
export type OwnerSentResult = {enqueued: boolean; reason?: string; agentId?: string; id?: string};
export type OwnerSentDeps = {
  readGrant?: (contactId: string) => Promise<any>;
  enqueue?: (injection: Record<string, unknown>) => Promise<any>;
  /** plugins.entries.<id>.hooks.allowPromptInjection of the current config (OpenClaw drains nothing when false). */
  promptInjectionAllowed?: () => boolean;
  clock?: () => number;
};

/** The longest text this method accepts, cut on code points (callers bound before calling). */
export function boundOwnerSentText(text: string) {
  const chars = Array.from(String(text || "").trim());
  return chars.length <= OWNER_SENT_MAX_TEXT ? chars.join("") : chars.slice(0, OWNER_SENT_MAX_TEXT - 1).join("") + "…";
}

/** Closed input: exact fields, E.164, an opaque send id, an ISO UTC time and a bounded single text. */
export function validateOwnerSent(params: unknown): OwnerSentInput | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const body = params as Record<string, unknown>, keys = Object.keys(body);
  if (keys.some(k => !REQUIRED.includes(k) && !OPTIONAL.includes(k)) || REQUIRED.some(k => !(k in body))) return null;
  const {e164, messageId, at, text, source = "owner_via_samantha", sessionKey} = body as any;
  if (typeof e164 !== "string" || !E164.test(e164) || typeof messageId !== "string" || !MESSAGE_ID.test(messageId) ||
      typeof at !== "string" || !AT.test(at) || !Number.isFinite(Date.parse(at)) || typeof text !== "string" ||
      typeof source !== "string" || !Object.prototype.hasOwnProperty.call(LABELS, source)) return null;
  const trimmed = text.trim();
  if (!trimmed || Array.from(trimmed).length > OWNER_SENT_MAX_TEXT || CONTROL.test(trimmed)) return null;
  if (sessionKey !== undefined && (typeof sessionKey !== "string" || contactRoomSession(sessionKey)?.e164 !== e164)) return null;
  return {e164, messageId, at, text: trimmed, source: source as OwnerSentSource, ...(sessionKey !== undefined ? {sessionKey} : {})};
}

export const ownerSentKey = (messageId: string) => "owner-send:" + messageId;
export function ownerSentText(input: Pick<OwnerSentInput, "source" | "at" | "messageId" | "text">) {
  return `[${LABELS[input.source]} · ${input.at} · id ${input.messageId}] « ${input.text} »`;
}

/** The room agent of an active, non-owner, unexpired grant of exactly this number (people-trusted.py room_agent). */
export function activeRoomAgent(grant: any, e164: string, now: number): string | null {
  const contactId = "wa-" + createHash("sha256").update(e164).digest("hex").slice(0, 16);
  if (grant?.success !== true || grant.state !== "active" || grant.owner !== false || grant.e164 !== e164 ||
      grant.contactId !== contactId || grant.expiresAt !== null && grant.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now)) return null;
  return roomAgentFor(grant.rooms);
}

export async function recordOwnerSent(input: OwnerSentInput, deps: OwnerSentDeps = {}): Promise<OwnerSentResult> {
  const clock = deps.clock || Date.now;
  if (deps.promptInjectionAllowed && deps.promptInjectionAllowed() === false) return {enqueued: false, reason: "prompt_injection_disabled"};
  if (typeof deps.enqueue !== "function") return {enqueued: false, reason: "injection_unavailable"};
  const readGrant = deps.readGrant || (contactId => allowlistRead("get", contactId));
  const contactId = "wa-" + createHash("sha256").update(input.e164).digest("hex").slice(0, 16);
  let grant: any;
  try {grant = await readGrant(contactId);}
  catch (error: any) {
    return error?.statusCode === 404 || error?.message === "unknown_contact" ? {enqueued: false, reason: "no_room"}
      : {enqueued: false, reason: "allowlist_unavailable"};
  }
  const agentId = activeRoomAgent(grant, input.e164, clock());
  if (!agentId) return {enqueued: false, reason: "no_room"};
  const sessionKey = `agent:${agentId}:whatsapp:direct:${input.e164}`;
  // A caller naming its room session (room send approvals) must name the room the contact is routed to now.
  if (input.sessionKey !== undefined && input.sessionKey !== sessionKey) return {enqueued: false, reason: "room_changed", agentId};
  let result: any;
  try {
    result = await deps.enqueue({sessionKey, agentId, text: ownerSentText(input), idempotencyKey: ownerSentKey(input.messageId),
      placement: "prepend_context", ttlMs: OWNER_SENT_TTL_MS,
      metadata: {messageId: input.messageId, at: input.at, source: input.source}});
  } catch {return {enqueued: false, reason: "injection_unavailable", agentId};}
  if (result?.enqueued === true) return {enqueued: true, agentId, id: String(result.id || "")};
  // SDK 2026.10.9 contract (host-hook-state enqueuePluginNextTurnInjection, registry wrapper): an absent session entry
  // returns an empty id (so does a plugin copy without lifecycle authority; prompt injection is checked above); a
  // duplicate idempotency key or a full queue (32 per session) returns the key itself, without telling them apart.
  // No session is created here: a room session is born from the contact's own routed message.
  if (!result || typeof result.id !== "string" || !result.id) return {enqueued: false, reason: "no_session", agentId};
  return {enqueued: false, reason: "already_enqueued_or_full", agentId, id: result.id};
}

/** The Gateway handler; `api` is the plugin api of this copy (its session workflow and current config). */
export function createOwnerSentHandler(api: any, deps: OwnerSentDeps = {}) {
  const pluginId = typeof api?.id === "string" && api.id ? api.id : "openclaw-plugin-mobile-ui";
  const workflow = () => api?.session?.workflow;
  const config = () => {try {return api?.runtime?.config?.current?.() ?? api?.config;} catch {return api?.config;}};
  const merged: OwnerSentDeps = {
    enqueue: typeof workflow()?.enqueueNextTurnInjection === "function"
      ? (injection => workflow().enqueueNextTurnInjection(injection)) : undefined,
    promptInjectionAllowed: () => config()?.plugins?.entries?.[pluginId]?.hooks?.allowPromptInjection !== false,
    ...deps,
  };
  return async ({params, respond}: any) => {
    const input = validateOwnerSent(params);
    if (!input) return respond(false, undefined, {code: "INVALID_REQUEST", message: "invalid owner_sent request"});
    respond(true, await recordOwnerSent(input, merged));
  };
}
