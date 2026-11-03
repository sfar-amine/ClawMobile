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

/**
 * Amine 02/11 (« un autorisé sur une pièce peut tout faire dedans »): the typed domain and tool of each room whose
 * contact brain calls typed tools (playbooks typed_tools.ROOM_DOMAINS). `projet` is the read-only file snapshot
 * (workspace `read`); `qa` has no typed owner yet, so no tool (room brain: UNTYPED_ROOMS).
 */
export const ROOM_TYPED = {
  pulse: {domain: "pulse", tool: "samantha_pulse"},
  agenda: {domain: "agenda", tool: "samantha_agenda"},
  actions: {domain: "device-assistance", tool: "samantha_device_assistance"},
  messages: {domain: "whatsapp", tool: "samantha_whatsapp"},
} as const;
export type TypedRoom = keyof typeof ROOM_TYPED;
export const TYPED_ROOMS = ORDER.filter((room): room is TypedRoom => room in ROOM_TYPED);
export const ROOM_TOOLS: ReadonlySet<string> = new Set(TYPED_ROOMS.map(room => ROOM_TYPED[room].tool));
export function toolRoom(toolName: unknown): TypedRoom | null {
  return TYPED_ROOMS.find(room => ROOM_TYPED[room].tool === toolName) || null;
}

/** The two Pulse room agents provisioned by pulse-room.py (people-trusted.py PULSE_AGENTS). */
export const PULSE_ROOM_AGENTS: ReadonlySet<string> = new Set(["contacts-pulse", "contacts-projet-pulse"]);

// people-trusted.py ROOMS: the order of an R17 agent name.
const R17_ROOMS = ["conversation", "projet", "pulse", "agenda", "taches", "lignes", "memoire", "actions", "messages", "qa", "maison"];
/** The agent the people-trusted owner routes these granted rooms to (people-trusted.py room_agent), main never. */
export function roomAgentFor(rooms: unknown): string | null {
  if (!Array.isArray(rooms) || rooms.some(room => !R17_ROOMS.includes(room)) || rooms.includes("maison")) return null;
  if (["agenda", "actions", "messages", "qa"].some(room => rooms.includes(room)))
    return "contacts-" + R17_ROOMS.filter(room => room !== "conversation" && rooms.includes(room)).join("-");
  if (rooms.includes("pulse")) return rooms.includes("projet") ? "contacts-projet-pulse" : "contacts-pulse";
  return rooms.includes("projet") ? "contacts-projet" : null;
}

/**
 * Amine 02/11: one room of a contact's brain. Identity comes from the routed agent and its WhatsApp session key (one
 * concrete-peer binding written after the owner's biometric), never from the model or the message text. The
 * principal is the contact in this room (`room:<pièce>:wa-…`); it is never « owner ».
 */
export function contactRoomPrincipal(agentId: unknown, sessionKey: unknown, room: TypedRoom) {
  // The SDK hook context may omit agentId (PluginHookToolContext.agentId?): the routed session key, host-authoritative,
  // then names the agent. When both are present they must agree.
  if (agentId !== undefined && typeof agentId !== "string" || typeof sessionKey !== "string" || !(room in ROOM_TYPED)) return null;
  const session = contactRoomSession(sessionKey);
  if (!session || agentId !== undefined && session.agent !== agentId || !session.rooms.has(room)) return null;
  const agent = session.agent;
  const contactId = "wa-" + createHash("sha256").update(session.e164).digest("hex").slice(0, 16);
  return {agent, room, rooms: TYPED_ROOMS.filter(r => session.rooms.has(r)), e164: session.e164, contactId, sessionKey,
    principal: `room:${room}:${contactId}`, conversationKey: `${room}-room:${agent}:${contactId}:${sessionKey}`};
}
export type RoomPrincipal = NonNullable<ReturnType<typeof contactRoomPrincipal>>;

/** The Pulse room of a contact session (the Pulse agents, or a combined room agent holding Pulse). */
export function pulseRoomSession(agentId: unknown, sessionKey: unknown) {
  return contactRoomPrincipal(agentId, sessionKey, "pulse");
}
export type PulseRoomSession = RoomPrincipal;
