import type {AdmissionTicket} from "./ownerTurnAdmission";
import type {CompanionRunStatus, IntentSubmitResponse} from "./types";
import {brainOnlyEnabled} from "../brainOnly";

/**
 * Brain delegation of a model-only Samantha Voix turn the dialogue coordinator left unresolved (Amine 25/10/2026: « il
 * doit absolument tout déléguer au cerveau »). Same owner as the app's ask_samantha tool: the canonical run submission
 * (POST /runs, voiceDelegation) and its run registry. No store, queue, retry or second route: one submission bound to
 * the turn's own admission ticket and clientRunId, then a bounded read of that run. A run still active at the budget
 * keeps going and lands in the discussion, as with ask_samantha (app DELEGATION_BUDGET_MS = 30 s).
 */
export const VOICE_BRAIN_BUDGET_MS = 30_000;
export const VOICE_BRAIN_POLL_MS = 500;
export const VOICE_BRAIN_SOURCE = "samantha_brain";
const VERBATIM_MAX_CHARS = 600;
const PENDING_TEXT = "Je te l'écris dans la discussion.";
const UNKNOWN_TEXT = "Je vérifie dans la discussion. Ne rejoue pas cette demande : son statut est incertain.";
const NOT_SUBMITTED_TEXT = "Je n'ai pas pu transmettre ta demande à Samantha. Tu peux la redire ?";
const FAILED_TEXT = "Samantha n'a pas pu terminer ta demande. Le détail est dans la discussion.";
const EMPTY_TEXT = "Samantha a terminé sans réponse à lire.";

type Submit = (text: string, sessionId: string, attachments: [], options: {
  userText: string; clientRunId: string; authority: "owner"; admission: AdmissionTicket; voiceDelegation: true;
}) => Promise<IntentSubmitResponse>;
type Status = (runId: string) => Promise<CompanionRunStatus>;
export type VoiceBrainDeps = {
  submit: Submit; status: Status; now?: () => number; sleep?: (ms: number) => Promise<void>; budgetMs?: number; pollMs?: number;
};
export type VoiceBrainContext = {sessionId: string; clientRunId: string; admission: AdmissionTicket; assertCurrent: () => void};

function code(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : undefined;
}

function spoken(text: unknown, fallback: string): string {
  const value = typeof text === "string" ? text.trim() : "";
  return value || fallback;
}

/** Receipt read by the voice: the brain's own text (or a fixed readable state sentence), imposed word for word when
 * short enough (voice.verbatim). Its speech is its own: the capability receipt template never rewrites it. */
function receipt(state: "done" | "failed" | "pending" | "unknown", text: string, extra: Record<string, unknown> = {}) {
  const success = state === "done" || state === "pending";
  const executionState = state === "done" ? "completed" : state;
  return {
    success, state, source: VOICE_BRAIN_SOURCE, text,
    delegation: {version: 1, target: "main_agent", owner: "runs"},
    execution: {state: executionState},
    ...(text.length <= VERBATIM_MAX_CHARS ? {voice: {version: 1, phase: state === "done" ? "none" : "failure", verbatim: text}} : {}),
    ...extra,
  };
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Model territory of a turn the coordinator left unresolved: only a model-only framing (Graph decision REASON, or no
 * decision with an optional tool policy). Every executable, clarifying or stopping decision (payments, deterministic
 * and agent routes alike) and an unavailable resolver keep the existing Graph executor, unchanged.
 */
export function brainTerritory(resolution: unknown): boolean {
  if (!isObject(resolution) || resolution.success === false) return false;
  const decision = isObject(resolution.decision) ? resolution.decision : null;
  if (decision) return decision.type === "REASON";
  const harness = isObject(resolution.harness) ? resolution.harness : null;
  return harness?.tool_policy === "optional";
}

export type UnresolvedVoiceDeps = VoiceBrainDeps & {
  resolve: (text: string) => Promise<unknown>;
  execute: (text: string) => Promise<Record<string, unknown>>;
};

/** /claw-live/capability, coordinator `continue`: executable turns keep their executor, model-only turns go to the brain. */
export async function routeUnresolvedVoiceTurn(request: string, ctx: VoiceBrainContext, deps: UnresolvedVoiceDeps) {
  if (brainOnlyEnabled()) {
    ctx.assertCurrent();
    return withTiming(await delegateVoiceTurnToBrain(request, ctx, deps), {route: "brain", resolveMs: 0});
  }
  const now = deps.now || (() => Date.now());
  const started = now();
  let resolution: unknown = null;
  try { resolution = await deps.resolve(request); } catch { resolution = null; }
  const resolveMs = elapsed(started, now());
  ctx.assertCurrent();
  if (!brainTerritory(resolution)) return withTiming(await deps.execute(request), {route: "capability", resolveMs});
  const result = await delegateVoiceTurnToBrain(request, ctx, deps);
  return withTiming(result, {route: "brain", resolveMs});
}

/** Measured durations only (no text, no identifier): read by the voice turn log line and the receipt. */
export type VoiceTiming = {route?: "brain" | "capability"; coordinatorMs?: number; resolveMs?: number; brainMs?: number};
function elapsed(start: number, end: number) { return Math.max(0, Math.min(600_000, Math.round(end - start))); }
export function withTiming<T extends Record<string, unknown>>(result: T, timing: VoiceTiming): T & {timing: VoiceTiming} {
  const previous = isObject(result?.timing) ? result.timing as VoiceTiming : {};
  return {...result, timing: {...previous, ...timing}};
}

export async function delegateVoiceTurnToBrain(request: string, ctx: VoiceBrainContext, deps: VoiceBrainDeps) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }));
  const budget = Math.max(1, Math.min(deps.budgetMs ?? VOICE_BRAIN_BUDGET_MS, 40_000));
  const poll = Math.max(50, Math.min(deps.pollMs ?? VOICE_BRAIN_POLL_MS, 5_000));
  const text = String(request || "").trim();
  if (!text) return receipt("failed", NOT_SUBMITTED_TEXT, {reason: "request_required", execution: {state: "not_submitted"}});
  // Admission is revalidated before the effect; an expired ticket refuses the turn without submitting anything.
  ctx.assertCurrent();
  const started = now();
  const deadline = started + budget;
  const timed = <T extends Record<string, unknown>>(value: T) => withTiming(value, {brainMs: elapsed(started, now())});
  let submitted: IntentSubmitResponse;
  try {
    submitted = await deps.submit(text, ctx.sessionId, [], {
      userText: text, clientRunId: ctx.clientRunId, authority: "owner", admission: ctx.admission, voiceDelegation: true,
    });
  } catch {
    // Acceptance cannot be ruled out: never claim, never resubmit.
    return timed(receipt("unknown", UNKNOWN_TEXT, {reason: "submission_outcome_unknown"}));
  }
  if (!submitted || submitted.success === false && submitted.accepted !== true || submitted.submissionState === "not_submitted") {
    return timed(receipt("failed", NOT_SUBMITTED_TEXT, {reason: code(submitted?.message) || "not_submitted", execution: {state: "not_submitted"}}));
  }
  const runId = String(submitted.runId || "");
  const refs = {runId, sessionId: ctx.sessionId, clientRunId: ctx.clientRunId};
  let state = submitted.state;
  let result: string | undefined = submitted.result;
  while (state === "running" && runId && now() < deadline) {
    await sleep(Math.min(poll, Math.max(1, deadline - now())));
    let status: CompanionRunStatus;
    try { status = await deps.status(runId); } catch { continue; }
    state = status.state;
    result = status.result ?? status.message;
  }
  if (state === "done") return timed(receipt("done", spoken(result, EMPTY_TEXT), refs));
  // A failed run's own text may be technical; the voice says a readable state and the detail stays in the discussion.
  if (state === "failed") return timed(receipt("failed", FAILED_TEXT, refs));
  if (state === "running") return timed(receipt("pending", PENDING_TEXT, refs));
  return timed(receipt("unknown", UNKNOWN_TEXT, refs));
}

/** One bounded log line per Samantha Voix capability turn: route and durations only, never the request or the answer. */
export function voiceTurnLogLine(result: unknown, totalMs: number): string {
  const r = isObject(result) ? result : {};
  const t = isObject(r.timing) ? r.timing as VoiceTiming : {};
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "-";
  const state = typeof r.state === "string" && /^[a-z_]{1,32}$/.test(r.state) ? r.state : "-";
  const route = t.route || (r.source === VOICE_BRAIN_SOURCE ? "brain" : "coordinator");
  return `[voice-turn] route=${route} state=${state} coordinator_ms=${num(t.coordinatorMs)} resolve_ms=${num(t.resolveMs)} brain_ms=${num(t.brainMs)} total_ms=${num(totalMs)}`;
}
