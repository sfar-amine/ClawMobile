/**
 * Pièces WhatsApp des contacts — le cerveau du contact autorisé (décision d'Amine du 02/11/2026 :
 * « Si quelqu'un est autorisé sur une pièce il peut tout faire dedans »).
 *
 * A WhatsApp contact holding rooms is routed by people-trusted.py to its room agent (`contacts-pulse`,
 * `contacts-projet-pulse`, or a combination `contacts-<pièces>` such as `contacts-agenda-actions`). Its own brain
 * reasons in its agent loop with the typed tool of each of its rooms (contactRoomProfile ROOM_TYPED: Pulse, agenda,
 * actions on the phone, messages), like Amine's own conversations. This REPLACES the native room interpretation
 * paths (pulseRoomFastPath, then contactRoomFastPath: before_dispatch interception + deterministic rendering): there
 * is one path, no per-room switch and no native fallback. One factory, one guard and one principal format
 * (`room:<pièce>:wa-…`) for every room; the Pulse room is one of them (#522, unchanged for its two agents).
 *
 * Scope is enforced at four places, none of them the model:
 *  1. tool factory: only a room agent on its own WhatsApp contact session gets these tools, one per typed room it
 *     holds, and only them (owner typed tools stay main-only; the agent tools policy, project-room.py
 *     room_tool_policy, closes everything else);
 *  2. before_tool_call (capabilityAgentGuard): the invocation proof carries the contact principal of the tool's room,
 *     never « owner », and only for a room the session holds;
 *  3. the room grant (people-trusted allowlist get) is read once per incoming message (agent run), and once more,
 *     uncached, right before a prepared write is handed off;
 *  4. playbooks `room_tool_turn`: the dialogue owner applies the room's scope policy (`pulse_room`, `room:<pièce>`):
 *     its domain only, the owner's SMS and photos refused, a write prepared then stopped at its hand-off.
 *
 * « Ne jamais inventer » (Amine 12/10): every answer that the owners already wrote (question, refusal, failure,
 * closed hours, verified write or read sentence) is delivered as is (`canDeliverSourceReply`, the turn ends; the
 * model does not restate it). A read whose owner gives only verified facts is returned to the model with those facts
 * and the rule to answer with them only, as in Amine's own typed turns.
 */
import os from "node:os";
import {allowlistRead} from "./companion/whatsappAllowlist";
import {runCapabilityHelperProcess} from "./companion/capabilityBridge";
import {consumeRoomInvocation} from "./capabilityAgentGuard";
import {contactRoomPrincipal, contactRoomSession, PULSE_ROOM_AGENTS, ROOM_TOOLS, ROOM_TYPED, roomAgentFor,
  TYPED_ROOMS, type RoomPrincipal, type TypedRoom} from "./contactRoomProfile";
import {createHash} from "node:crypto";
import {NATIVE_PULSE_PROTOCOL} from "./nativePulseAdmission";
import {actionParamShapes, readTypedToolCatalogue, type Action, type DomainTool} from "./typedCapabilityTools";
import {runtimeFile} from "./runtimeRoot";

export {PULSE_ROOM_AGENTS, ROOM_TOOLS};
export const PULSE_ROOM_REFUSAL = "Ici je ne traite que Pulse : projets, offres, congés de l'équipe et solde de congés. Pour le reste, vois directement avec Amine.";
// Amine 26/10: a constraint, not a refusal. The room acts with Amine's Pulse account, so a leave
// request posted here would be recorded as Amine's leave.
export const LEAVE_REQUEST_REFUSAL = "Désolé, je ne peux pas prendre en compte les demandes de congé : j’utilise le compte Pulse d’Amine, donc un congé posé ici serait enregistré au nom d’Amine. Merci de poser ta demande de congé directement dans Pulse, avec ton propre compte.";
// Amine 31/10 (playbooks confirmation_policy.OWNER_PRIVATE_READS): no room grant reaches the owner's SMS and photos.
export const OWNER_PRIVATE_REFUSAL = "Les SMS et les photos du téléphone d’Amine lui sont réservés : je ne peux pas les consulter ici.";
export const ROOM_ACCESS_REFUSED = "L’accès à la pièce Pulse n’est pas confirmé. Rien n’a été exécuté.";
export const ROOM_UNVERIFIED = "Je n’ai pas de résultat vérifié de Pulse pour cette demande. Rien n’est rejoué automatiquement : vérifie son état avant tout nouvel essai.";
export const ROOM_WRITE_STOPPED = "La modification était prête, mais l’accès à la pièce Pulse n’est plus confirmé : rien n’a été envoyé à Pulse.";
// receipt_presentation.py (fr.spoken): the opaque receipt fallback, never a business answer by itself.
const GENERIC_RECEIPT = "Le résultat de la demande reste à vérifier.";
const CLOSED_SENTENCE = /^Pulse est fermé en ce moment \(ouvert [^()\n]{1,120}\)\. Réessaie [^\n]{1,80}$/u;
const MAX_EVENT_REF = 300;

/** The fixed sentences of each room (the Pulse ones are the deployed #522 sentences, unchanged). */
type RoomTexts = {label: string; scope: string; access: string; unverified: string; stopped: string; noDetail: string;
  facts: string; rules: string};
const RULES_TAIL = " Choisis l'action et ses paramètres typés à partir des mots du contact ; n'invente aucune valeur : laisse " +
  "vide ce qui n'est pas dit, l'outil pose lui-même la question. Les réponses prêtes de l'outil sont remises telles quelles " +
  "au contact. Quand une question de cet outil attend une réponse, indique relation : answer si le contact y répond, " +
  "new_request s'il fait une nouvelle demande.";
function roomTexts(name: string, of: string, to: string, scope: string, subjects: string): RoomTexts {
  return {label: name, scope,
    access: `L’accès à la pièce ${name} n’est pas confirmé. Rien n’a été exécuté.`,
    unverified: `Je n’ai pas de résultat vérifié ${of} pour cette demande. Rien n’est rejoué automatiquement : vérifie son état avant tout nouvel essai.`,
    stopped: `L’action était prête, mais l’accès à la pièce ${name} n’est plus confirmé : rien n’a été envoyé ${to}.`,
    noDetail: `Aucun détail vérifié n’a été renvoyé ${of} pour cette demande.`,
    facts: `Faits vérifiés renvoyés ${of}. Réponds au contact uniquement avec ces faits, en français, sans rien ajouter, déduire ni compléter de mémoire.`,
    rules: `Outil de la pièce ${name} d'un contact autorisé d'Amine. Pour toute demande sur ${subjects} : appelle cet outil, ` +
      `jamais de réponse de mémoire.${RULES_TAIL} Cet outil ne sert qu'à la pièce ${name} ; hors des pièces ouvertes à ce ` +
      "contact, rien n'est possible."};
}
const TEXTS: Record<TypedRoom, RoomTexts> = {
  pulse: {label: "Pulse", scope: "Pulse (projets, offres, congés de l'équipe et solde de congés)", access: ROOM_ACCESS_REFUSED,
    unverified: ROOM_UNVERIFIED, stopped: ROOM_WRITE_STOPPED,
    noDetail: "Pulse n’a renvoyé aucun détail vérifié pour cette demande.",
    facts: "Faits vérifiés renvoyés par Pulse. Réponds au contact uniquement avec ces faits, en français, sans rien ajouter, déduire ni compléter de mémoire.",
    rules: "Outil unique de la pièce Pulse d'un contact autorisé d'Amine. Pour toute demande sur les projets, offres, " +
      "phases, équipes, consommations, forecasts, congés de l'équipe ou solde de congés : appelle cet outil, jamais de réponse de " +
      "mémoire. Choisis l'action et ses paramètres typés à partir des mots du contact ; n'invente aucune valeur (nom, client, " +
      "date, montant) : laisse vide ce qui n'est pas dit, l'outil pose lui-même la question. Les réponses prêtes de l'outil sont " +
      "remises telles quelles au contact. Quand une question de cet outil attend une réponse, indique relation : answer si le " +
      "contact y répond, new_request s'il fait une nouvelle demande. Hors de Pulse, rien n'est possible dans cette pièce."},
  agenda: roomTexts("Agenda", "de l’agenda", "à l’agenda", "l’agenda d’Amine",
    "l'agenda d'Amine (consulter ses rendez-vous, en créer, en déplacer ou en modifier, programmer un rappel)"),
  actions: roomTexts("Actions", "du téléphone", "au téléphone", "les réglages et actions courantes de son téléphone",
    "le téléphone d'Amine (état, batterie, Wi-Fi, Bluetooth, volume, sonnerie, luminosité, alarme, minuteur, torche, ouvrir une application ou un réglage)"),
  messages: roomTexts("Messages", "de WhatsApp", "sur WhatsApp", "l’envoi de messages WhatsApp en son nom",
    "l'envoi d'un message WhatsApp au nom d'Amine (destinataire et texte donnés par le contact)"),
};
/** Actions of a room's domain that the room never runs, refused before any read (and again by playbooks). */
const ROOM_REFUSED: Partial<Record<TypedRoom, Record<string, {text: string; reason: string}>>> = {
  pulse: {"leave.request": {text: LEAVE_REQUEST_REFUSAL, reason: "scope_leave_request"}},
  actions: {"device.sms.latest": {text: OWNER_PRIVATE_REFUSAL, reason: "scope_owner_private"},
    "device.photos.today": {text: OWNER_PRIVATE_REFUSAL, reason: "scope_owner_private"}},
};
/** Rooms without a typed owner yet: no tool, so nothing runs there (named reason, not a fallback). */
export const UNTYPED_ROOMS: Readonly<Record<string, string>> = {qa: "room_domain_not_typed"};

/** The refusal of a request outside the contact's rooms: the Pulse sentence in a Pulse-only room (#522). */
export function roomRefusal(rooms: readonly TypedRoom[]) {
  if (rooms.length === 1 && rooms[0] === "pulse") return PULSE_ROOM_REFUSAL;
  const scopes = rooms.map(room => TEXTS[room].scope);
  const listed = scopes.length > 1 ? scopes.slice(0, -1).join(", ") + " et " + scopes[scopes.length - 1] : scopes[0] || "";
  return `Ici je ne traite que ${listed}. Pour le reste, vois directement avec Amine.`;
}

type GrantRead = (contactId: string) => Promise<any>;
type TypedRun = (privateInput: string) => Promise<any>;
export type RoomToolOptions = {
  home?: string; helperPath?: string; catalogue?: DomainTool[];
  /** Tests only: the existing people-trusted read (allowlistRead get) otherwise. */
  readGrant?: GrantRead;
  /** Tests only: the typed helper process otherwise. */
  runTyped?: TypedRun;
};
export type PulseRoomToolOptions = RoomToolOptions;
type RoomContext = {agentId?: string; sessionKey?: string; sessionId?: string; senderIsOwner?: boolean;
  messageChannel?: string; assertInvocationCurrent?: () => void};

/**
 * One room grant read per incoming message: the agent run (OpenClaw runId) is the message, whatever room tool of the
 * session asks. Process-wide (several plugin copies share one Gateway), bounded, and dropped on failure so a failed
 * read is never reused.
 */
const MESSAGE_GRANTS = Symbol.for("samantha.room.message-grants.v1");
const GRANT_TTL_MS = 10 * 60_000, GRANT_ENTRIES = 256;
function messageGrants(): Map<string, {at: number; value: Promise<any>}> {
  const holder = globalThis as any;
  const existing = Object.getOwnPropertyDescriptor(holder, MESSAGE_GRANTS)?.value;
  if (existing instanceof Map) return existing;
  const created = new Map();
  Object.defineProperty(holder, MESSAGE_GRANTS, {value: created, writable: false, configurable: false, enumerable: false});
  return created;
}
export function messageGrant(room: RoomPrincipal, runId: string, read: GrantRead, now = Date.now()): Promise<any> {
  const grants = messageGrants(), key = room.agent + "|" + room.contactId + "|" + runId, held = grants.get(key);
  if (held && now >= held.at && now - held.at < GRANT_TTL_MS) return held.value;
  for (const [k, entry] of grants) if (now - entry.at >= GRANT_TTL_MS) grants.delete(k);
  while (grants.size >= GRANT_ENTRIES) grants.delete(grants.keys().next().value as string);
  const value = read(room.contactId);
  grants.set(key, {at: now, value});
  value.catch(() => { if (grants.get(key)?.value === value) grants.delete(key); });
  return value;
}

/**
 * Amine 02/11 — the room brain: one admission packet for ONE typed call of a room contact, from a grant value the
 * caller has just read (allowlistRead get): active, not the owner, this contact, routed to this very agent (so holding
 * exactly these rooms, the call's room among them), not expired. The packet goes to the Graph on the private stdin of
 * the typed helper; it is correlation for 30 s, never a credential.
 */
export function roomGrantPacket(room:{agent:string;room?:string;contactId:string;e164:string;conversationKey:string},eventRef:string,
  current:any,now=Date.now()){
  if(current?.success!==true||current.state!=='active'||current.owner!==false||current.contactId!==room.contactId||
     !Array.isArray(current.rooms)||roomAgentFor(current.rooms)!==room.agent||!current.rooms.includes(room.room||'pulse')||
     typeof current.e164!=='string'||current.e164!==room.e164||'wa-'+createHash('sha256').update(current.e164).digest('hex').slice(0,16)!==room.contactId||
     current.expiresAt!==null&&(!Number.isFinite(Date.parse(current.expiresAt))||Date.parse(current.expiresAt)<=now))
    throw Error('room_grant_revoked');
  if(typeof eventRef!=='string'||!eventRef||eventRef.length>300||eventRef.startsWith('untracked:'))throw Error('room_event_invalid');
  return {schema_version:NATIVE_PULSE_PROTOCOL,contact_id:room.contactId,conversation_key:room.conversationKey,
    event_ref:eventRef,observed_at:now,valid_until:now+30000};
}

/** The typed rooms of this contact tool context, or null (owner, other agent, other session, group, other channel). */
export function roomSession(context: RoomContext): {rooms: TypedRoom[]} | null {
  if (!context || context.senderIsOwner === true) return null;
  if (context.messageChannel !== undefined && context.messageChannel !== "whatsapp") return null;
  const session = contactRoomSession(context.sessionKey);
  if (!session || context.agentId !== undefined && context.agentId !== session.agent) return null;
  const rooms = TYPED_ROOMS.filter(room => session.rooms.has(room));
  return rooms.length ? {rooms} : null;
}

/** The Pulse room contact of this tool context, or null (#522 name, kept for the Pulse recette and tests). */
export function pulseRoomPrincipal(context: RoomContext): RoomPrincipal | null {
  return roomSession(context)?.rooms.includes("pulse") ? contactRoomPrincipal(context.agentId, context.sessionKey, "pulse") : null;
}

/** Actions the room may call: qualified command owners of its domain (no native browser owner, no candidate). */
export function roomActions(tool: DomainTool): Action[] {
  return tool.actions.filter(a => a.canonicalStatus === "ready" && a.executionMode === "command" &&
    ["read", "write", "external_send"].includes(a.risk));
}

function roomSchema(actions: Action[]) {
  return {type: "object", properties: {
    action: {type: "string", enum: actions.map(a => a.action)},
    params: {anyOf: actionParamShapes(actions)},
    relation: {type: "string", enum: ["answer", "new_request"]},
  }, required: ["action", "params"], additionalProperties: false};
}

function delivered(text: string, state: string, reasonCode = "") {
  return {content: [{type: "text", text: JSON.stringify({state, reasonCode, answer: text})}],
    details: {sourceReply: {text}}};
}

/** The reply of a room typed turn: the owners' own text delivered as is, or verified facts for the model. */
export function roomToolReply(result: any, room: TypedRoom = "pulse", refusal = PULSE_ROOM_REFUSAL) {
  const texts = TEXTS[room];
  const state = String(result?.state || ""), reason = String(result?.reasonCode || "");
  const answer = typeof result?.answer === "string" ? result.answer.trim() : "";
  switch (state) {
    case "COMPLETED": {
      if (answer && answer !== GENERIC_RECEIPT) return delivered(answer, state);
      const facts = result?.facts;
      if (facts && typeof facts === "object" && Object.keys(facts).length)
        return {content: [{type: "text", text: JSON.stringify({state, facts, instruction: texts.facts})}],
          details: {verifiedFacts: true}};
      return delivered(texts.noDetail, state);
    }
    case "OUTSIDE_SCOPE": return delivered(refusal, state, reason);
    case "DENIED":
      return delivered(reason === "scope_leave_request" ? LEAVE_REQUEST_REFUSAL :
        reason === "scope_owner_private" ? OWNER_PRIVATE_REFUSAL : refusal, state, reason);
    case "TECHNICAL_FAILURE":
      if (reason === "service_closed" && CLOSED_SENTENCE.test(answer)) return delivered(answer, state, reason);
      return delivered(answer || texts.unverified, state, reason);
    default: return delivered(answer || texts.unverified, state || "unverified", reason);
  }
}

/** The typed helper of the room owner (playbooks room_tool_turn), on its private stdin. */
export function roomTypedHelper(options: {home?: string; helperPath?: string} = {}): TypedRun {
  return async privateInput => {
    if (Buffer.byteLength(privateInput) > 32768) throw Error("typed_input_too_large");
    const raw = await runCapabilityHelperProcess([options.helperPath || runtimeFile("claw-capability.py", options.home),
      "typed-tool", "--host-input-stdin", "--timeout", "30"],
      {timeoutMs: 38000, maxBuffer: 128 * 1024, env: {...process.env}, privateInput});
    return JSON.parse(typeof raw === "string" ? raw : String(raw?.stdout || "{}"));
  };
}

/**
 * The private host identity of one room call: the contact, never the owner (playbooks ROOM_HOST). Every room uses the
 * coordinator's room surface `pulse_room` (its historical name); the conversation key names the room and agent.
 */
export function roomHost(room: {room?: string; contactId: string; conversationKey: string}, runId: string, invocationId: string) {
  return {room: room.room || "pulse", contactId: room.contactId, conversationKey: room.conversationKey, userRunId: runId,
    invocationId, surface: "pulse_room", graphSurface: "whatsapp"};
}

function createRoomTool(context: RoomContext, room: RoomPrincipal, tool: DomainTool, refusal: string,
  read: GrantRead, typed: TypedRun) {
  const actions = roomActions(tool);
  if (!actions.length) return null;
  const texts = TEXTS[room.room], domain = ROOM_TYPED[room.room].domain, refused = ROOM_REFUSED[room.room] || {};
  const parameters = roomSchema(actions);
  const list = actions.map(a => `${a.action}: ${a.description}`).join("\n");
  return {name: tool.name, description: `${texts.rules}\n${list}`,
    schema: parameters, inputSchema: parameters, parameters, catalogMode: "direct-only" as const, canDeliverSourceReply: true,
    async execute(toolCallId: unknown, args: any) {
      let reached = "admission";
      try {
        const bound = consumeRoomInvocation(toolCallId, tool.name, args, context);
        if (bound.principal !== room.principal) throw Error("typed_host_admission_required");
        if (!args || typeof args !== "object" || Array.isArray(args) ||
            Object.keys(args).some(k => !["action", "params", "relation"].includes(k)) || typeof args.action !== "string" ||
            (args.relation !== undefined && !["answer", "new_request"].includes(args.relation)) ||
            !args.params || typeof args.params !== "object" || Array.isArray(args.params)) throw Error("typed_input_invalid");
        const action = actions.find(a => a.action === args.action);
        if (!action) return delivered(refusal, "OUTSIDE_SCOPE", "scope_outside");
        // Same constraint as the room policy, before any read (Pulse: Amine's account; actions: his SMS and photos).
        const constraint = refused[action.action];
        if (constraint) return delivered(constraint.text, "DENIED", constraint.reason);
        const eventRef = bound.userRunId + ":" + bound.invocationId;
        if (eventRef.length > MAX_EVENT_REF) throw Error("typed_input_invalid");
        reached = "grant";
        // Once per incoming message (agent run), shared by every call of this run, whatever the room tool.
        const grant = await messageGrant(room, bound.userRunId, read).catch(() => null);
        let packet;
        try { packet = roomGrantPacket(room, eventRef, grant); }
        catch { return delivered(texts.access, "DENIED", "room_grant_revoked"); }
        const host = roomHost(room, bound.userRunId, bound.invocationId);
        const command = {operation: "call", domain, action: action.action, params: args.params,
          ...(args.relation ? {relation: args.relation} : {})};
        context.assertInvocationCurrent!();
        reached = "turn";
        let result = await typed(JSON.stringify({command, host, roomAdmission: packet}));
        const goalRef = result?.prepared?.goalRef;
        if (typeof goalRef === "string" && goalRef) {
          // A complete write, prepared and bound; nothing has been done yet. Re-read the grant now.
          let fresh = null;
          try { fresh = roomGrantPacket(room, eventRef, await read(room.contactId)); } catch { fresh = null; }
          let current = !!fresh;
          if (current) try { context.assertInvocationCurrent!(); } catch { current = false; }
          if (!current) {
            // No effect: closes the prepared hand-off. The packet only correlates this event (message grant value).
            reached = "abort";
            await typed(JSON.stringify({command: {operation: "abort", domain, goalRef, reason: "admission_revoked"},
              host, roomAdmission: fresh || roomGrantPacket(room, eventRef, grant)}));
            return delivered(texts.stopped, "DENIED", "room_grant_revoked");
          }
          reached = "handoff";
          result = await typed(JSON.stringify({command: {operation: "handoff", domain, goalRef}, host,
            roomAdmission: fresh}));
        }
        return roomToolReply(result, room.room, refusal);
      } catch (error: any) {
        // After the hand-off started the outcome is unknown: never replayed, the contact is told to check first.
        const reason = typeof error?.message === "string" && /^typed_[a-z_]+$/.test(error.message) ? error.message
          : reached === "handoff" ? "typed_outcome_unverified" : "typed_" + reached + "_unavailable";
        return delivered(texts.unverified, "unverified", reason);
      }
    }};
}

/** The one room factory: the typed tool of each typed room this contact session holds, and nothing else. */
export function createRoomTools(context: RoomContext, options: RoomToolOptions = {}) {
  const session = roomSession(context);
  if (!session) return null;
  const catalogue = options.catalogue || readTypedToolCatalogue(options.home || os.homedir());
  const read: GrantRead = options.readGrant || (contactId => allowlistRead("get", contactId));
  const typed = options.runTyped || roomTypedHelper(options);
  const refusal = roomRefusal(session.rooms);
  const tools = session.rooms.flatMap(name => {
    const room = contactRoomPrincipal(context.agentId, context.sessionKey, name);
    const tool = catalogue.find(t => t.domain === ROOM_TYPED[name].domain && t.name === ROOM_TYPED[name].tool);
    const made = room && tool && ROOM_TOOLS.has(tool.name) ? createRoomTool(context, room, tool, refusal, read, typed) : null;
    return made ? [made] : [];
  });
  return tools.length ? tools : null;
}
