import {TURN_BUDGET_MS} from "./turnBudget";
import type {AdmissionTicket} from "./ownerTurnAdmission";
import type {CompanionRunStatus, IntentSubmitResponse} from "./types";

/**
 * Brain delegation of every Samantha Voix turn (Amine 25/10/2026: « il doit absolument tout déléguer au cerveau » ;
 * ADR 02/11 « le cerveau partout », step 3: no coordinator or Graph before it). Same owner as the app's ask_samantha tool: the canonical run submission
 * (POST /runs, voiceDelegation) and its run registry. No store, queue, retry or second route: one submission bound to
 * the turn's own admission ticket and clientRunId, then a bounded read of that run. A run still active at the budget
 * keeps going and lands in the discussion, as with ask_samantha (app DELEGATION_BUDGET_MS = 30 s); when the voice
 * session owner takes the deferred result (VoiceDeferredOwner), its answer is also read back in that session, once.
 */
export const VOICE_BRAIN_BUDGET_MS = TURN_BUDGET_MS;
export const VOICE_BRAIN_POLL_MS = 500;
export const VOICE_BRAIN_SOURCE = "samantha_brain";
/**
 * Deferred readback of a brain turn (S24 30/10 22:21, « Quel est l'état de mes factures » : the brain answered 0.4 s after
 * the 30 s voice budget and the voice said nothing). When the voice session owner takes the deferred result, the same
 * bounded read of the same run goes on after the budget, at a slower cadence, until the run settles, the session closes,
 * a newer request supersedes the turn or the follow horizon ends; the settled receipt goes to that owner, once. No store,
 * queue, retry or second submission.
 */
export const VOICE_DEFERRED_FOLLOW_MS = 5 * 60_000;
export const VOICE_DEFERRED_POLL_MS = 1_000;
/**
 * Said once when the brain has not answered within the voice budget; the answer follows in the same voice session.
 * Waiting cues (Amine 31/10/2026): the app already said what is being done, so this is information only, never a second
 * « je cherche encore » filler; it is the only notice of the turn (the app plays no spoken filler after its one phrase).
 */
export const VOICE_PENDING_NOTICE = "Je te donne la réponse dès que je l'ai.";
const VERBATIM_MAX_CHARS = 600;
const PENDING_TEXT = VOICE_PENDING_NOTICE;
const UNKNOWN_TEXT = "Je vérifie dans la discussion. Ne rejoue pas cette demande : son statut est incertain.";
const NOT_SUBMITTED_TEXT = "Je n'ai pas pu transmettre ta demande à Samantha. Tu peux la redire ?";
const FAILED_TEXT = "Samantha n'a pas pu terminer ta demande. Le détail est dans la discussion.";
const EMPTY_TEXT = "Samantha a terminé sans réponse à lire.";

type Submit = (text: string, sessionId: string, attachments: [], options: {
  userText: string; clientRunId: string; authority: "owner"; admission: AdmissionTicket; voiceDelegation: true;
}) => Promise<IntentSubmitResponse>;
type Status = (runId: string) => Promise<CompanionRunStatus>;
/** Owner of a deferred brain result: the voice turn protocol of the session that asked (exactly-once readback). */
export type VoiceDeferredOwner = {alive: () => boolean; settle: (receipt: Record<string, unknown>) => void};
export type VoiceBrainDeps = {
  submit: Submit; status: Status; now?: () => number; sleep?: (ms: number) => Promise<void>; budgetMs?: number; pollMs?: number;
  deferred?: VoiceDeferredOwner; followMs?: number; followPollMs?: number;
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

/** /claw-live/capability: the admitted voice turn goes to Samantha's brain, with no resolver call before it. */
export async function routeVoiceTurnToBrain(request: string, ctx: VoiceBrainContext, deps: VoiceBrainDeps) {
  ctx.assertCurrent();
  return withTiming(await delegateVoiceTurnToBrain(request, ctx, deps), {route: "brain", resolveMs: 0});
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
  if (state === "running") {
    const pending = timed(receipt("pending", PENDING_TEXT, {...refs, ...(deps.deferred && runId ? {deferredReadback: {version: 1, owner: "voice_turn"}} : {})}));
    if (deps.deferred && runId) {
      const followMs = Math.max(1, Math.min(deps.followMs ?? VOICE_DEFERRED_FOLLOW_MS, 15 * 60_000));
      const followPoll = Math.max(50, Math.min(deps.followPollMs ?? VOICE_DEFERRED_POLL_MS, 10_000));
      void followDeferredRun(runId, refs, deps.deferred, {status: deps.status, now, sleep, poll: followPoll, until: now() + followMs});
    }
    return pending;
  }
  return timed(settledReceipt(state, result, refs));
}

/** Terminal receipt of a brain run, the same before and after the voice budget. */
function settledReceipt(state: CompanionRunStatus["state"] | undefined, result: string | undefined, refs: Record<string, unknown>) {
  if (state === "done") return receipt("done", spoken(result, EMPTY_TEXT), refs);
  // A failed run's own text may be technical; the voice says a readable state and the detail stays in the discussion.
  if (state === "failed") return receipt("failed", FAILED_TEXT, refs);
  return receipt("unknown", UNKNOWN_TEXT, refs);
}

/**
 * The bounded read of the same run, continued after the voice budget for the deferred owner only. It stops as soon as
 * the owner no longer wants the result (session closed, newer request, already spoken) and hands the terminal receipt
 * over once. A read error is retried at the next tick, never turned into a claim.
 */
async function followDeferredRun(runId: string, refs: Record<string, unknown>, owner: VoiceDeferredOwner,
  d: {status: Status; now: () => number; sleep: (ms: number) => Promise<void>; poll: number; until: number}) {
  try {
    while (d.now() < d.until) {
      await d.sleep(Math.min(d.poll, Math.max(1, d.until - d.now())));
      if (!owner.alive()) return;
      let status: CompanionRunStatus;
      try { status = await d.status(runId); } catch { continue; }
      if (status.state === "running") continue;
      if (owner.alive()) owner.settle(settledReceipt(status.state, status.result ?? status.message, refs));
      return;
    }
  } catch { /* the run and its discussion are unaffected */ }
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
