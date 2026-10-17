const ORDER = ["projet", "pulse", "agenda", "actions", "messages"] as const;
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
