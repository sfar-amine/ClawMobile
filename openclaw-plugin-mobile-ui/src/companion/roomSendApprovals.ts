/**
 * Amine 02/11 — a WhatsApp send in Amine's name asked by a messages-room contact runs only after AMINE confirms that
 * very send. Reused owners, no parallel approval store:
 *  - the Companion owner confirmation (confirmations.ts / confirmationCore.ts): biometric, signed by the owner key,
 *    120 s, single use, persisted in the existing run registry whose only writer is this Companion process;
 *  - the app's existing confirmation screen (OwnerConfirmationActivity, kind « confirmation »), opened from a Termux
 *    notification exactly like the QA campaign notification;
 *  - the room owner (playbooks room_tool_turn) and its prepared command: `handoff` once, or `abort`.
 *
 * The room tool (roomBrain.ts, Gateway process) has prepared the send and re-read the grant; it asks for the owner
 * confirmation here and answers the contact « en attente de la confirmation d'Amine ». This module is the trusted
 * in-process consumer: on Amine's confirmation it re-reads the grant, consumes the confirmation against the exact
 * intent, then hands the same prepared command off once (never replayed); on refusal or expiry it aborts it. The
 * contact is told the outcome on the existing Gateway `send` (same RPC as the owner progress notice). A Companion
 * restart loses only the in-memory wait: the confirmation then expires unconsumed and nothing is sent.
 */
import {createHash} from "crypto";
import {allowlistRead} from "./whatsappAllowlist";
import {confirmations as ownerConfirmations} from "./confirmations";
import {callOpenClawGateway} from "./openclawAgentClient";
import {ownerBinding, ownerText, type OwnerIntent} from "./ownerConfirmationProtocol";
import {contactRoomPrincipal, type RoomPrincipal} from "../contactRoomProfile";
import {ROOM_SEND_TEXTS, roomGrantPacket, roomHost, roomTypedHelper} from "../roomBrain";
export {ROOM_SEND_TEXTS};
import {runTermuxCommand} from "../backends/termux";
import {ownerConfirmationNotificationArgs} from "../backends/ownerConfirmationNotification";

export const ROOM_SEND_ACTION = "whatsapp.room_send";
const DOMAIN = "whatsapp";
const GENERIC_RECEIPT = "Le résultat de la demande reste à vérifier.";
const GOAL = /^goal-[a-f0-9]{8,64}$/;
const RUN = /^[A-Za-z0-9_.:|-]{1,200}$/;
const MAX_PENDING = 32;

type Confirmations = Pick<typeof ownerConfirmations, "prepare" | "status" | "cancel" | "consume" | "recordStep">;
export type RoomSendDeps = {
  confirmations?: Confirmations;
  readGrant?: (contactId: string) => Promise<any>;
  runTyped?: (privateInput: string) => Promise<any>;
  sendContact?: (params: {to: string; accountId: string | null; message: string; idempotencyKey: string}) => Promise<any>;
  notifyOwner?: (requestId: string, title: string, content: string) => Promise<boolean>;
  clock?: () => number;
  timer?: (fn: () => unknown, ms: number) => {unref?: () => void} | any;
};
type Pending = {id: string; room: RoomPrincipal; eventRef: string; userRunId: string; invocationId: string; goalRef: string;
  accountId: string | null; recipient: string; intent: OwnerIntent; expiresAt: number; grant: any; busy?: boolean};

const fail = (code: string, statusCode = 400): never => {throw Object.assign(new Error(code), {statusCode});};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function requestKey(seed: string) {
  const h = sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The request of the room host (closed shape): the prepared goal, its room event, and the BOUND command parameters. */
export function validateRoomSendRequest(body: any) {
  const keys = ["schemaVersion", "goalRef", "agentId", "sessionKey", "userRunId", "invocationId", "accountId", "parameters"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== keys.length ||
      keys.some(k => !Object.prototype.hasOwnProperty.call(body, k)) || body.schemaVersion !== 1 ||
      typeof body.goalRef !== "string" || !GOAL.test(body.goalRef) || typeof body.userRunId !== "string" || !RUN.test(body.userRunId) ||
      typeof body.invocationId !== "string" || !RUN.test(body.invocationId) ||
      body.accountId !== null && (typeof body.accountId !== "string" || !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(body.accountId)))
    fail("invalid_room_send_request");
  const room = contactRoomPrincipal(body.agentId, body.sessionKey, "messages");
  const p = body.parameters;
  if (!room || !p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join(",") !== "message,recipient" ||
      typeof p.recipient !== "string" || typeof p.message !== "string") fail("invalid_room_send_request");
  const eventRef = body.userRunId + ":" + body.invocationId;
  if (eventRef.length > 300) fail("invalid_room_send_request");
  return {room: room!, goalRef: body.goalRef as string, userRunId: body.userRunId as string, invocationId: body.invocationId as string,
    eventRef, accountId: body.accountId as string | null, recipient: p.recipient as string, message: p.message as string};
}

/** Exactly what Amine reads and signs: who asks, the recipient and the whole text, never shortened or rewritten. */
export function roomSendIntent(room: RoomPrincipal, who: string, request: {goalRef: string; eventRef: string; recipient: string; message: string}): OwnerIntent {
  const subtitle = `${who} → ${request.recipient}`, description = `« ${request.message} »`;
  if (!ownerText(request.recipient, 60) || !ownerText(request.message, 300) || !ownerText(subtitle, 96) || !ownerText(description, 320))
    fail("owner_confirmation_not_presentable", 409);
  const payloadHash = sha(JSON.stringify(["claw.room.send.v1", room.principal, room.conversationKey, request.goalRef,
    request.eventRef, request.recipient, request.message]));
  return {audience: "confirmation", action: {type: ROOM_SEND_ACTION, reference: request.goalRef, payloadHash},
    presentation: {title: "Message au nom d’Amine", subtitle, description}, origin: {channel: "samantha", id: room.principal}};
}

function requester(room: RoomPrincipal, grant: any) {
  const name = typeof grant?.name === "string" ? grant.name.trim() : "";
  return name && ownerText(name, 40) ? name : room.e164;
}

export function createRoomSendApprovals(deps: RoomSendDeps = {}) {
  const store = deps.confirmations || ownerConfirmations;
  const readGrant = deps.readGrant || (contactId => allowlistRead("get", contactId));
  const typed = deps.runTyped || roomTypedHelper();
  const clock = deps.clock || Date.now;
  const timer = deps.timer || ((fn: () => unknown, ms: number) => setTimeout(fn, ms));
  const sendContact = deps.sendContact || (params => callOpenClawGateway("send", {channel: "whatsapp", to: params.to,
    ...(params.accountId ? {accountId: params.accountId} : {}), message: params.message, idempotencyKey: params.idempotencyKey},
    {timeoutMs: 5000, hardTimeoutMs: 5000}));
  const notifyOwner = deps.notifyOwner || (async (id, title, content) =>
    (await runTermuxCommand("termux-notification", ownerConfirmationNotificationArgs(id, title, content), 5000)).ok);
  const pending = new Map<string, Pending>();

  const tell = async (entry: Pending, kind: string, message: string) => {
    try {
      await sendContact({to: entry.room.e164, accountId: entry.accountId, message,
        idempotencyKey: "samantha-room-send-" + sha(entry.id + "|" + kind).slice(0, 40)});
      return true;
    } catch {return false;}
  };
  const step = (id: string, outcome: string) => store.recordStep(id, {stage: "confirmation_consume", outcome}).catch(() => undefined);
  const command = (entry: Pending, extra: Record<string, unknown>) => ({domain: DOMAIN, goalRef: entry.goalRef, ...extra});
  async function abort(entry: Pending, reason: string, packet: any) {
    try {
      await typed(JSON.stringify({command: command(entry, {operation: "abort", reason}),
        host: roomHost(entry.room, entry.userRunId, entry.invocationId),
        roomAdmission: packet || roomGrantPacket(entry.room, entry.eventRef, entry.grant, clock())}));
      return true;
    } catch {return false;}
  }

  return {
    /** The room host's request: prepare Amine's confirmation (nothing runs), notify him, wait for his decision. */
    async request(body: any) {
      const request = validateRoomSendRequest(body);
      if (pending.size >= MAX_PENDING) fail("owner_confirmation_capacity", 409);
      const grant = await readGrant(request.room.contactId).catch(() => null);
      try {roomGrantPacket(request.room, request.eventRef, grant, clock());} catch {fail("room_grant_revoked", 403);}
      const intent = roomSendIntent(request.room, requester(request.room, grant), request);
      const prepared: any = await store.prepare({requestKey: requestKey("room-send|" + request.room.principal + "|" + request.goalRef),
        action: intent.action, presentation: intent.presentation, origin: intent.origin});
      if (prepared.state !== "awaiting_owner") fail("owner_confirmation_not_pending", 409);
      const id = prepared.requestId as string;
      if (!pending.has(id)) {
        pending.set(id, {id, room: request.room, eventRef: request.eventRef, userRunId: request.userRunId,
          invocationId: request.invocationId, goalRef: request.goalRef, accountId: request.accountId, recipient: request.recipient,
          intent, expiresAt: prepared.expiresAt, grant});
        await store.recordStep(id, {stage: "handoff_prepared", outcome: "awaiting_owner"}).catch(() => undefined);
        const job = timer(() => this.decided(id).catch(() => undefined), Math.max(0, prepared.expiresAt - clock()) + 1000);
        job?.unref?.();
      }
      const notified = await notifyOwner(id, "Samantha · Message à confirmer", intent.presentation.subtitle).catch(() => false);
      return {schemaVersion: 1, state: "awaiting_owner", confirmationRequestId: id, expiresAt: prepared.expiresAt,
        notificationSent: notified === true, reply: ROOM_SEND_TEXTS.pending(request.recipient)};
    },

    /** Amine decided (confirm or cancel route), or the confirmation expired: run the outcome once. */
    async decided(id: string) {
      const entry = pending.get(id);
      if (!entry || entry.busy) return {state: "not_pending"};
      entry.busy = true;
      let state: string;
      try {state = (await store.status(id) as any).state;} catch {entry.busy = false; return {state: "unreadable"};}
      if (state === "awaiting_owner" && clock() < entry.expiresAt) {entry.busy = false; return {state};}
      pending.delete(id); // single flight: this decision is taken once, never replayed
      if (state === "approved") {
        let packet: any = null;
        try {packet = roomGrantPacket(entry.room, entry.eventRef, await readGrant(entry.room.contactId), clock());} catch {packet = null;}
        if (!packet) {
          await abort(entry, "admission_revoked", null);await step(id, "room_grant_revoked");
          await tell(entry, "stopped", ROOM_SEND_TEXTS.stopped);return {state: "aborted", reason: "room_grant_revoked"};
        }
        let consumed: any;
        try {consumed = await store.consume(id, entry.intent);} catch {consumed = null;}
        if (!consumed || consumed.bindingHash !== ownerBinding(entry.intent)) {
          await abort(entry, "owner_confirmation_unavailable", packet);await step(id, "owner_confirmation_unusable");
          await tell(entry, "unverified", ROOM_SEND_TEXTS.unverifiedConfirmation);return {state: "aborted", reason: "owner_confirmation_unusable"};
        }
        let result: any;
        try {
          result = await typed(JSON.stringify({command: command(entry, {operation: "handoff",
            ownerConfirmation: {requestId: id, bindingHash: consumed.bindingHash}}),
            host: roomHost(entry.room, entry.userRunId, entry.invocationId), roomAdmission: packet}));
        } catch {
          // The hand-off started: its outcome is unknown and never replayed.
          await step(id, "handoff_outcome_unknown");await tell(entry, "unknown", ROOM_SEND_TEXTS.unknown);
          return {state: "unverified"};
        }
        const answer = typeof result?.answer === "string" ? result.answer.trim() : "";
        const done = result?.state === "COMPLETED";
        await step(id, done ? "sent" : "send_not_completed");
        await tell(entry, "outcome", done ? (answer && answer !== GENERIC_RECEIPT ? answer : ROOM_SEND_TEXTS.confirmed(entry.recipient))
          : answer || ROOM_SEND_TEXTS.unknown);
        return {state: done ? "sent" : "not_completed"};
      }
      if (state === "cancelled") {
        await abort(entry, "owner_refused", null);await step(id, "owner_refused");
        await tell(entry, "refused", ROOM_SEND_TEXTS.refused(entry.recipient));return {state: "aborted", reason: "owner_refused"};
      }
      // Expired (or still awaiting at the deadline): closed without any effect.
      if (state === "awaiting_owner") await store.cancel(id).catch(() => undefined);
      await abort(entry, "owner_confirmation_expired", null);await step(id, "owner_confirmation_expired");
      await tell(entry, "expired", ROOM_SEND_TEXTS.expired(entry.recipient));return {state: "aborted", reason: "owner_confirmation_expired"};
    },
    pendingCount: () => pending.size,
  };
}

let shared: ReturnType<typeof createRoomSendApprovals> | null = null;
/** The Companion's single consumer (lazy: no notification, timer or Gateway call before the first request). */
export function roomSendApprovals() {return shared || (shared = createRoomSendApprovals());}
