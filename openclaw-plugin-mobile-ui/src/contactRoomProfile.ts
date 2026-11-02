import {createHash} from "node:crypto";
const ORDER = ["projet", "pulse", "agenda", "actions", "messages", "qa"] as const;
export type ContactRoom = typeof ORDER[number];
const SESSION = /^agent:(contacts(?:-[a-z]+)*):whatsapp:direct:(\+?[1-9][0-9]{7,14})$/;

/** Parse only profiles that the R17 owner can generate; an arbitrary agent/session name grants nothing. */
export function contactRoomSession(value: unknown) {
  const match = SESSION.exec(String(value || ""));
  if (!match) return null;
  const parts = match[1].split("-").slice(1);
  const rooms = ORDER.filter(room => parts.includes(room));
  if (parts.length !== rooms.length || parts.join("-") !== rooms.join("-")) return null;
  return { agent: match[1], rooms: new Set<ContactRoom>(rooms), e164: match[2].startsWith("+") ? match[2] : "+" + match[2] };
}

/** The two Pulse room agents provisioned by pulse-room.py (people-trusted.py PULSE_AGENTS). */
export const PULSE_ROOM_AGENTS: ReadonlySet<string> = new Set(["contacts-pulse", "contacts-projet-pulse"]);

/**
 * Amine 02/11: the brain of a Pulse room contact. Identity comes from the routed agent and its WhatsApp session key
 * (one concrete-peer binding written after the owner's biometric), never from the model or the message text.
 * The returned principal is the contact; it is never « owner ».
 */
export function pulseRoomSession(agentId: unknown, sessionKey: unknown) {
  // The SDK hook context may omit agentId (PluginHookToolContext.agentId?): the routed session key, host-authoritative,
  // then names the agent. When both are present they must agree.
  if (agentId !== undefined && typeof agentId !== "string" || typeof sessionKey !== "string") return null;
  const session = contactRoomSession(sessionKey);
  if (!session || !PULSE_ROOM_AGENTS.has(session.agent) || agentId !== undefined && session.agent !== agentId ||
      !session.rooms.has("pulse")) return null;
  const agent = session.agent;
  const contactId = "wa-" + createHash("sha256").update(session.e164).digest("hex").slice(0, 16);
  return {agent, e164: session.e164, contactId, sessionKey, principal: `room:pulse:${contactId}`,
    conversationKey: `pulse-room:${agent}:${contactId}:${sessionKey}`};
}
export type PulseRoomSession = NonNullable<ReturnType<typeof pulseRoomSession>>;
