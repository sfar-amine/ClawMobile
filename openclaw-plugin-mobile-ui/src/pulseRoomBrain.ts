/**
 * Pièce « Pulse » — le cerveau du contact autorisé (décision d'Amine du 02/11/2026 :
 * « Un autorisé sur une pièce peut tout faire dedans »).
 *
 * A WhatsApp contact holding the `pulse` room is routed by people-trusted.py to `contacts-pulse` or
 * `contacts-projet-pulse`. Its own brain now reasons in its agent loop with the room's typed tool only
 * (`samantha_pulse`), like Amine's own conversations. This REPLACES the native room interpretation path
 * (before_dispatch interception + one interpreter call + dialogue coordinator): there is one path, no switch.
 *
 * Scope is enforced at four places, none of them the model:
 *  1. tool factory: only a Pulse room agent on its own WhatsApp contact session gets this tool, and only it
 *     (owner typed tools stay main-only; the agent tools policy of pulse-room.py closes everything else);
 *  2. before_tool_call (capabilityAgentGuard): the invocation proof carries the contact principal, never « owner »;
 *  3. the room grant (people-trusted allowlist get) is read once per incoming message (agent run), and once more,
 *     uncached, right before a prepared write is handed off;
 *  4. playbooks `room_tool_turn`: the dialogue owner applies the same `pulse_room` scope policy as the native room
 *     (direct write only when complete, questions for missing values, leave requests and anything else refused).
 *
 * « Ne jamais inventer » (Amine 12/10): every answer that the owners already wrote (question, refusal, failure,
 * closed hours, verified write or read sentence) is delivered as is (`canDeliverSourceReply`, the turn ends; the
 * model does not restate it). A read whose owner gives only verified facts is returned to the model with those facts
 * and the rule to answer with them only, as in Amine's own typed turns.
 */
import os from "node:os";
import {allowlistRead} from "./companion/whatsappAllowlist";
import {runCapabilityHelperProcess} from "./companion/capabilityBridge";
import {consumeRoomInvocation, PULSE_ROOM_TOOLS} from "./capabilityAgentGuard";
import {pulseRoomSession, type PulseRoomSession, PULSE_ROOM_AGENTS} from "./contactRoomProfile";
import {createHash} from "node:crypto";
import {NATIVE_PULSE_PROTOCOL} from "./nativePulseAdmission";
import {actionParamShapes, readTypedToolCatalogue, type Action, type DomainTool} from "./typedCapabilityTools";
import {runtimeFile} from "./runtimeRoot";

export {PULSE_ROOM_AGENTS};
export const PULSE_ROOM_REFUSAL = "Ici je ne traite que Pulse : projets, offres, congés de l'équipe et solde de congés. Pour le reste, vois directement avec Amine.";
// Amine 26/10: a constraint, not a refusal. The room acts with Amine's Pulse account, so a leave
// request posted here would be recorded as Amine's leave.
export const LEAVE_REQUEST_REFUSAL = "Désolé, je ne peux pas prendre en compte les demandes de congé : j’utilise le compte Pulse d’Amine, donc un congé posé ici serait enregistré au nom d’Amine. Merci de poser ta demande de congé directement dans Pulse, avec ton propre compte.";
export const ROOM_ACCESS_REFUSED = "L’accès à la pièce Pulse n’est pas confirmé. Rien n’a été exécuté.";
export const ROOM_UNVERIFIED = "Je n’ai pas de résultat vérifié de Pulse pour cette demande. Rien n’est rejoué automatiquement : vérifie son état avant tout nouvel essai.";
export const ROOM_WRITE_STOPPED = "La modification était prête, mais l’accès à la pièce Pulse n’est plus confirmé : rien n’a été envoyé à Pulse.";
const NO_DETAIL = "Pulse n’a renvoyé aucun détail vérifié pour cette demande.";
// receipt_presentation.py (fr.spoken): the opaque receipt fallback, never a business answer by itself.
const GENERIC_RECEIPT = "Le résultat de la demande reste à vérifier.";
const CLOSED_SENTENCE = /^Pulse est fermé en ce moment \(ouvert [^()\n]{1,120}\)\. Réessaie [^\n]{1,80}$/u;
const FACTS_ONLY = "Faits vérifiés renvoyés par Pulse. Réponds au contact uniquement avec ces faits, en français, sans rien ajouter, déduire ni compléter de mémoire.";
const ROOM_DOMAIN = "pulse";
const MAX_EVENT_REF = 300;

type GrantRead = (contactId: string) => Promise<any>;
type TypedRun = (privateInput: string) => Promise<any>;
export type PulseRoomToolOptions = {
  home?: string; helperPath?: string; catalogue?: DomainTool[];
  /** Tests only: the existing people-trusted read (allowlistRead get) otherwise. */
  readGrant?: GrantRead;
  /** Tests only: the typed helper process otherwise. */
  runTyped?: TypedRun;
};
type RoomContext = {agentId?: string; sessionKey?: string; sessionId?: string; senderIsOwner?: boolean;
  messageChannel?: string; assertInvocationCurrent?: () => void};

/**
 * One room grant read per incoming message: the agent run (OpenClaw runId) is the message. Process-wide (several
 * plugin copies share one Gateway), bounded, and dropped on failure so a failed read is never reused.
 */
const MESSAGE_GRANTS = Symbol.for("samantha.pulse-room.message-grants.v1");
const GRANT_TTL_MS = 10 * 60_000, GRANT_ENTRIES = 256;
function messageGrants(): Map<string, {at: number; value: Promise<any>}> {
  const holder = globalThis as any;
  const existing = Object.getOwnPropertyDescriptor(holder, MESSAGE_GRANTS)?.value;
  if (existing instanceof Map) return existing;
  const created = new Map();
  Object.defineProperty(holder, MESSAGE_GRANTS, {value: created, writable: false, configurable: false, enumerable: false});
  return created;
}
export function messageGrant(room: PulseRoomSession, runId: string, read: GrantRead, now = Date.now()): Promise<any> {
  const grants = messageGrants(), key = room.principal + "|" + runId, held = grants.get(key);
  if (held && now >= held.at && now - held.at < GRANT_TTL_MS) return held.value;
  for (const [k, entry] of grants) if (now - entry.at >= GRANT_TTL_MS) grants.delete(k);
  while (grants.size >= GRANT_ENTRIES) grants.delete(grants.keys().next().value as string);
  const value = read(room.contactId);
  grants.set(key, {at: now, value});
  value.catch(() => { if (grants.get(key)?.value === value) grants.delete(key); });
  return value;
}

/** Same agent the people-trusted owner routes these rooms to (people-trusted.py room_agent). */
function pulseRoomAgentFor(rooms:string[]):string|null{
  if(!rooms.includes('pulse')||rooms.includes('maison')||['agenda','actions','messages','qa'].some(room=>rooms.includes(room)))return null;
  return rooms.includes('projet')?'contacts-projet-pulse':'contacts-pulse';
}

/**
 * Amine 02/11 — the room brain: one admission packet for ONE typed call of a room contact, from a grant value the
 * caller has just read (allowlistRead get). Same checks as NativePulseContact.packet, plus the routed agent. The
 * packet goes to the Graph on the private stdin of the typed helper; it is correlation for 30 s, never a credential.
 */
export function roomGrantPacket(room:{agent:string;contactId:string;e164:string;conversationKey:string},eventRef:string,
  current:any,now=Date.now()){
  if(current?.success!==true||current.state!=='active'||current.owner!==false||current.contactId!==room.contactId||
     !Array.isArray(current.rooms)||pulseRoomAgentFor(current.rooms)!==room.agent||
     typeof current.e164!=='string'||current.e164!==room.e164||'wa-'+createHash('sha256').update(current.e164).digest('hex').slice(0,16)!==room.contactId||
     current.expiresAt!==null&&(!Number.isFinite(Date.parse(current.expiresAt))||Date.parse(current.expiresAt)<=now))
    throw Error('room_grant_revoked');
  if(typeof eventRef!=='string'||!eventRef||eventRef.length>300||eventRef.startsWith('untracked:'))throw Error('room_event_invalid');
  return {schema_version:NATIVE_PULSE_PROTOCOL,contact_id:room.contactId,conversation_key:room.conversationKey,
    event_ref:eventRef,observed_at:now,valid_until:now+30000};
}

/** The room contact of this tool context, or null (owner, other agent, other session, group, other channel). */
export function pulseRoomPrincipal(context: RoomContext): PulseRoomSession | null {
  if (!context || context.senderIsOwner === true) return null;
  if (context.messageChannel !== undefined && context.messageChannel !== "whatsapp") return null;
  return pulseRoomSession(context.agentId, context.sessionKey);
}

/** Actions the room may call: qualified command owners of its domain (no native browser owner, no candidate). */
export function roomActions(tool: DomainTool): Action[] {
  return tool.actions.filter(a => a.canonicalStatus === "ready" && a.executionMode === "command" &&
    ["read", "write"].includes(a.risk));
}

function roomSchema(actions: Action[]) {
  return {type: "object", properties: {
    action: {type: "string", enum: actions.map(a => a.action)},
    params: {anyOf: actionParamShapes(actions)},
    relation: {type: "string", enum: ["answer", "new_request"]},
  }, required: ["action", "params"], additionalProperties: false};
}

const ROOM_RULES = "Outil unique de la pièce Pulse d'un contact autorisé d'Amine. Pour toute demande sur les projets, offres, " +
  "phases, équipes, consommations, forecasts, congés de l'équipe ou solde de congés : appelle cet outil, jamais de réponse de " +
  "mémoire. Choisis l'action et ses paramètres typés à partir des mots du contact ; n'invente aucune valeur (nom, client, " +
  "date, montant) : laisse vide ce qui n'est pas dit, l'outil pose lui-même la question. Les réponses prêtes de l'outil sont " +
  "remises telles quelles au contact. Quand une question de cet outil attend une réponse, indique relation : answer si le " +
  "contact y répond, new_request s'il fait une nouvelle demande. Hors de Pulse, rien n'est possible dans cette pièce.";

function delivered(text: string, state: string, reasonCode = "") {
  return {content: [{type: "text", text: JSON.stringify({state, reasonCode, answer: text})}],
    details: {sourceReply: {text}}};
}

/** The reply of a room typed turn: the owners' own text delivered as is, or verified facts for the model. */
export function roomToolReply(result: any) {
  const state = String(result?.state || ""), reason = String(result?.reasonCode || "");
  const answer = typeof result?.answer === "string" ? result.answer.trim() : "";
  switch (state) {
    case "COMPLETED": {
      if (answer && answer !== GENERIC_RECEIPT) return delivered(answer, state);
      const facts = result?.facts;
      if (facts && typeof facts === "object" && Object.keys(facts).length)
        return {content: [{type: "text", text: JSON.stringify({state, facts, instruction: FACTS_ONLY})}],
          details: {verifiedFacts: true}};
      return delivered(NO_DETAIL, state);
    }
    case "OUTSIDE_SCOPE": return delivered(PULSE_ROOM_REFUSAL, state, reason);
    case "DENIED":
      return delivered(reason === "scope_leave_request" ? LEAVE_REQUEST_REFUSAL : PULSE_ROOM_REFUSAL, state, reason);
    case "TECHNICAL_FAILURE":
      if (reason === "service_closed" && CLOSED_SENTENCE.test(answer)) return delivered(answer, state, reason);
      return delivered(answer || ROOM_UNVERIFIED, state, reason);
    default: return delivered(answer || ROOM_UNVERIFIED, state || "unverified", reason);
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

/** The private host identity of one room call: the contact, never the owner (playbooks ROOM_HOST). */
export function roomHost(room: PulseRoomSession, runId: string, invocationId: string) {
  return {room: "pulse", contactId: room.contactId, conversationKey: room.conversationKey, userRunId: runId,
    invocationId, surface: "pulse_room", graphSurface: "whatsapp"};
}

export function createPulseRoomTools(context: RoomContext, options: PulseRoomToolOptions = {}) {
  const room = pulseRoomPrincipal(context);
  if (!room) return null;
  const tool = (options.catalogue || readTypedToolCatalogue(options.home || os.homedir())).find(t => t.domain === ROOM_DOMAIN);
  if (!tool || !PULSE_ROOM_TOOLS.has(tool.name)) return null;
  const actions = roomActions(tool);
  if (!actions.length) return null;
  const read: GrantRead = options.readGrant || (contactId => allowlistRead("get", contactId));
  const typed = options.runTyped || roomTypedHelper(options);
  const parameters = roomSchema(actions);
  const list = actions.map(a => `${a.action}: ${a.description}`).join("\n");
  return [{name: tool.name, description: `${ROOM_RULES}\n${list}`,
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
        if (!action) return delivered(PULSE_ROOM_REFUSAL, "OUTSIDE_SCOPE", "scope_outside");
        // Same constraint as the room policy, before any read: Pulse would record it under Amine's account.
        if (action.action === "leave.request") return delivered(LEAVE_REQUEST_REFUSAL, "DENIED", "scope_leave_request");
        const eventRef = bound.userRunId + ":" + bound.invocationId;
        if (eventRef.length > MAX_EVENT_REF) throw Error("typed_input_invalid");
        reached = "grant";
        // Once per incoming message (agent run), shared by every call of this run.
        const grant = await messageGrant(room, bound.userRunId, read).catch(() => null);
        let packet;
        try { packet = roomGrantPacket(room, eventRef, grant); }
        catch { return delivered(ROOM_ACCESS_REFUSED, "DENIED", "room_grant_revoked"); }
        const host = roomHost(room, bound.userRunId, bound.invocationId);
        const command = {operation: "call", domain: ROOM_DOMAIN, action: action.action, params: args.params,
          ...(args.relation ? {relation: args.relation} : {})};
        context.assertInvocationCurrent!();
        reached = "turn";
        let result = await typed(JSON.stringify({command, host, roomAdmission: packet}));
        const goalRef = result?.prepared?.goalRef;
        if (typeof goalRef === "string" && goalRef) {
          // A complete write, prepared and bound; nothing has been sent to Pulse yet. Re-read the grant now.
          let fresh = null;
          try { fresh = roomGrantPacket(room, eventRef, await read(room.contactId)); } catch { fresh = null; }
          let current = !!fresh;
          if (current) try { context.assertInvocationCurrent!(); } catch { current = false; }
          if (!current) {
            // No effect: closes the prepared hand-off. The packet only correlates this event (message grant value).
            reached = "abort";
            await typed(JSON.stringify({command: {operation: "abort", domain: ROOM_DOMAIN, goalRef, reason: "admission_revoked"},
              host, roomAdmission: fresh || roomGrantPacket(room, eventRef, grant)}));
            return delivered(ROOM_WRITE_STOPPED, "DENIED", "room_grant_revoked");
          }
          reached = "handoff";
          result = await typed(JSON.stringify({command: {operation: "handoff", domain: ROOM_DOMAIN, goalRef}, host,
            roomAdmission: fresh}));
        }
        return roomToolReply(result);
      } catch (error: any) {
        // After the hand-off started the outcome is unknown: never replayed, the contact is told to check first.
        const reason = typeof error?.message === "string" && /^typed_[a-z_]+$/.test(error.message) ? error.message
          : reached === "handoff" ? "typed_outcome_unverified" : "typed_" + reached + "_unavailable";
        return delivered(ROOM_UNVERIFIED, "unverified", reason);
      }
    }}];
}
