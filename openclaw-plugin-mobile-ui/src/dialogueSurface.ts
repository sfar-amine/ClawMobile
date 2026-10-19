import crypto from "node:crypto";
import { readReceiptPresentation, publicReceiptMetadata } from "./companion/receiptPresentation";
import type { DialogueMode, DialogueWebContext, FastPathResult, RunnerOptions } from "./modelFastPath";
import { PUBLIC_WEB_BUDGET_MS, readRunWebResult, webResultText, webRunState, type RunWebResult } from "./companion/runWeb";

/**
 * SAM-MIG-CC-001 V2.2 — surface adapter of the dialogue coordinator (ADR-DIALOGUE, programme doc 57).
 *
 * The coordinator (samantha-ui-playbooks `skill_intelligence/dialogue/`) is the ONLY owner of dialogue state:
 * conversation, request, versioned question, fields, subject references and hand-off marker, in its private
 * SQLite store. It runs inside `model-fast-path.py --dialogue` (option B: no new process). This module keeps NO
 * state: no Map, no pending question, no TTL. It only builds the admitted event from the existing admission
 * owner (OpenClaw messageId, clientRunId, voice/Claw Live turn origin) and adapts the FORM of the common
 * rendering. The three former authorities (Pulse room Maps, the in-process surface clarification copy, the
 * run-registry clarifications)
 * are removed.
 */
export type DialogueSurfaceName = "whatsapp" | "pulse_room" | "app" | "voice" | "claw_live";

export type DialogueReply = {
  outcome: string;
  reasonCode?: string;
  /** Transport reason when the coordinator could not be reached (helper_missing, helper_failed…). */
  source?: string;
  text?: string;
  conversationRef?: string | null;
  goalRef?: string | null;
  modelAllowed?: boolean;
  handled?: boolean;
  question?: { version?: number; kind?: string; text?: string; choices?: unknown[]; expiresAt?: number } | null;
  metadata?: Record<string, unknown> | null;
  decision?: Record<string, unknown> | null;
  handoff?: { status: string; klass: string } | null;
  pendingHandoff?: { goalRef: string; klass: string } | null;
  replayed?: boolean;
};

export type DialogueRunner = (message: string, options?: RunnerOptions) => Promise<FastPathResult>;

export type DialogueInput = {
  /** Host-only QA room authority, excluded from the dialogue event and policy payloads. */
  qaContext?:Record<string,unknown>;
  surface: DialogueSurfaceName;
  graphSurface: string;
  conversationKey: string;
  eventRef: string;
  text: string;
  caller?: "owner" | "trusted" | "other";
  admittedAt?: number;
  policy?: Record<string, unknown>;
  timeoutSeconds?: number;
  /** Parallel Free (W4): host-only run/session/deadline metadata for a Web hand-off; never dialogue state. */
  web?: DialogueWebContext;
};

export const DIALOGUE_UNAVAILABLE_TEXT =
  "Je ne peux pas traiter ta demande pour le moment : le suivi de conversation de Samantha est indisponible. Rien n'a été exécuté ; réessaie dans un instant.";
const QUESTION_OUTCOMES = new Set(["NEEDS_INPUT", "NEEDS_CHOICE", "NEEDS_CONFIRMATION", "STALE_QUESTION"]);
const DONE_OUTCOMES = new Set(["COMPLETED", "WAITING_OPERATION"]);
const OUTCOMES = new Set([...QUESTION_OUTCOMES, ...DONE_OUTCOMES, "READY", "UNRESOLVED", "DENIED", "OUTSIDE_SCOPE",
  "NEW_GOAL", "TECHNICAL_FAILURE", "FAILED", "EVENT_ID_CONFLICT", "MAINTENANCE", "STALE_EPOCH", "HANDOFF_INTERRUPTED"]);

/** Opaque, stable conversation id handed to clients (voice relay, Claw Live) — same format as before. */
export function dialogueConversationId(surface: DialogueSurfaceName, key: string): string {
  return "clar-" + crypto.createHash("sha256").update(surface + "\n" + String(key)).digest("hex").slice(0, 24);
}

const CONVERSATION_ID = /^clar-[a-f0-9]{24}$/;
export function isDialogueConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

/** Fail closed: anything that is not a coordinator reply is a bounded technical failure, never a fallback. */
export function asDialogueReply(raw: unknown): DialogueReply {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    // The helper transport's own reason (helper_missing, helper_failed…) is kept for the N1 failure presentation.
    const source = value.status === "error" && typeof value.reason === "string" ? value.reason : "invalid_result";
    return { outcome: "TECHNICAL_FAILURE", reasonCode: "coordinator_unavailable", source, text: DIALOGUE_UNAVAILABLE_TEXT,
      handled: true, modelAllowed: false };
  }
  const reply = value as unknown as DialogueReply;
  const modelAllowed = reply.modelAllowed === true && reply.outcome === "UNRESOLVED";
  return { ...reply, modelAllowed, handled: modelAllowed ? reply.handled === true : true };
}

/** A transport identity from the existing admission owner; never invented from the text. */
export function transportEventRef(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() && value !== "capability-first") return value.trim().slice(0, 300);
  }
  // No owner identity: this turn has no replay protection of its own (documented residual), never a shared key.
  return "untracked:" + Date.now() + ":" + crypto.randomBytes(6).toString("hex");
}

export function admittedAtMs(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function runnerOptions(input: DialogueInput, mode: DialogueMode): RunnerOptions {
  return {
    ...(input.qaContext?{qaContext:input.qaContext}:{}),
    surface: input.graphSurface,
    caller: input.caller || "owner",
    originId: input.eventRef.slice(0, 120),
    timeoutSeconds: input.timeoutSeconds ?? 75,
    dialogue: input.web ? { ...mode, web: input.web } : mode,
  };
}

function eventOf(input: DialogueInput) {
  return { surface: input.surface, conversationKey: input.conversationKey, eventRef: input.eventRef,
    caller: input.caller || "owner", ...(input.admittedAt ? { admittedAt: input.admittedAt } : {}) };
}

export async function dialogueTurn(runner: DialogueRunner, input: DialogueInput): Promise<DialogueReply> {
  try {
    const raw = await runner(input.text, runnerOptions(input, { mode: "turn", event: eventOf(input), policy: input.policy || {} }));
    return asDialogueReply(raw);
  } catch {
    return asDialogueReply({ status: "error", reason: "helper_failed" });
  }
}

/** Second half of a deferred turn (app, doc 43): execute or abort the hand-off already committed with its decision. */
export async function dialogueHandoff(runner: DialogueRunner, input: DialogueInput, goalRef: string, abort = false): Promise<DialogueReply> {
  try {
    const raw = await runner(input.text, runnerOptions(input, { mode: abort ? "abort" : "handoff", event: eventOf(input), policy: input.policy || {}, goalRef }));
    return asDialogueReply(raw);
  } catch {
    return asDialogueReply({ status: "error", reason: "helper_failed" });
  }
}

export function isQuestionReply(reply: DialogueReply): boolean {
  return QUESTION_OUTCOMES.has(reply.outcome) || (reply.outcome === "UNRESOLVED" && !!reply.question);
}

export function isDoneReply(reply: DialogueReply): boolean {
  return DONE_OUTCOMES.has(reply.outcome);
}

export type SurfaceTurn =
  | { state: "needs_clarification"; clarificationId: string; question: string; choices: unknown[]; decision?: Record<string, unknown>; presentation?: unknown }
  | { state: "done" | "failed"; text: string; source: "capability"; result?: unknown; web?: RunWebResult; decision?: Record<string, unknown>; presentation?: unknown }
  | { state: "continue"; text: string; resolvedFrom?: string; decision?: Record<string, unknown>; presentation?: unknown };

/** Closed `run.web` projection carried by the coordinator reply metadata (W4); anything malformed is dropped. */
export function dialogueWebOf(reply: DialogueReply): RunWebResult | undefined {
  return readRunWebResult((reply.metadata as Record<string, unknown> | null | undefined)?.web);
}

function metadataOf(reply: DialogueReply) {
  return publicReceiptMetadata(readReceiptPresentation((reply.metadata || {}) as any));
}

/** Form of the common rendering for turn-based surfaces (voice relay, Claw Live). Stateless. */
export function surfaceTurnOf(reply: DialogueReply, conversationId: string, originalText: string): SurfaceTurn {
  const decision = reply.decision || undefined;
  if (isQuestionReply(reply)) {
    return { state: "needs_clarification", clarificationId: conversationId,
      question: String(reply.text || reply.question?.text || "Précise ce que tu veux faire."),
      choices: Array.isArray(reply.question?.choices) ? reply.question!.choices! : [], decision, ...metadataOf(reply) };
  }
  const web = dialogueWebOf(reply);
  if (web && (isDoneReply(reply) || reply.outcome === "FAILED")) {
    // The text is rebuilt from admitted claims/sources only; no second, unverified answer reaches the surface.
    return { state: isDoneReply(reply) ? webRunState(web) : "failed", source: "capability", text: webResultText(web), web, result: { web }, decision, ...metadataOf(reply) };
  }
  if (isDoneReply(reply)) return { state: "done", source: "capability", text: String(reply.text || "Claw a terminé la capacité."), decision, ...metadataOf(reply) };
  if (reply.outcome === "UNRESOLVED" && reply.modelAllowed && !reply.handled) return { state: "continue", text: originalText, decision, ...metadataOf(reply) };
  return { state: "failed", source: "capability", text: String(reply.text || DIALOGUE_UNAVAILABLE_TEXT), decision, ...metadataOf(reply) };
}

/** Turn-based surfaces: the conversation id IS the coordinator's conversation key (no local pending state). */
export class DialogueSurface {
  constructor(private runner: DialogueRunner, private surface: DialogueSurfaceName, private graphSurface: string,
              private policy: Record<string, unknown> = { modelAllowed: true },
              /** Voice surfaces (voice relay, Claw Live): a Web hand-off stays closed by default (G6, host recipe only). */
              private host: { voice?: boolean } = {}) {}

  async turn(text: string, options: { id?: string; originId: string; admittedAt?: number; timeoutSeconds?: number; assertCurrent?: () => void; caller?: "owner" | "trusted" | "other"; sessionId?: string; runId?: string }): Promise<SurfaceTurn> {
    const webDeadlineEpochMs = Date.now() + PUBLIC_WEB_BUDGET_MS;
    options.assertCurrent?.();
    const original = String(text || "").trim();
    const conversationId = isDialogueConversationId(options.id) ? options.id : dialogueConversationId(this.surface, "turn:" + options.originId);
    // Doc 43 (P1): an admitted surface revalidates its ticket between the committed decision and the effect.
    const deferred = typeof options.assertCurrent === "function";
    const input: DialogueInput = {
      surface: this.surface, graphSurface: this.graphSurface, conversationKey: conversationId,
      eventRef: transportEventRef(options.originId), text: original, caller: options.caller || "owner",
      admittedAt: options.admittedAt ?? Date.now(), policy: { ...this.policy, ...(deferred ? { deferHandoff: true } : {}) },
      timeoutSeconds: options.timeoutSeconds ?? 75,
      web: { runId: options.runId, sessionId: options.sessionId, deadlineEpochMs: webDeadlineEpochMs, voiceDelegation: this.host.voice === true },
    };
    let reply = await dialogueTurn(this.runner, input);
    if (reply.outcome === "READY" && reply.pendingHandoff?.goalRef) {
      try {
        options.assertCurrent?.();
      } catch (error) {
        await dialogueHandoff(this.runner, input, reply.pendingHandoff.goalRef, true);
        throw error;
      }
      reply = await dialogueHandoff(this.runner, input, reply.pendingHandoff.goalRef);
    }
    options.assertCurrent?.();
    return surfaceTurnOf(reply, conversationId, original);
  }
}
