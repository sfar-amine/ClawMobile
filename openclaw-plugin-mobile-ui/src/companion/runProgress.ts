/** HS5 — run steps derived on read from existing receipts only (runs.json run, decision,
 * HS3 presentation, Gateway progress events). Nothing is stored, invented or simulated. */
import type {CompanionRunProgressEvent} from "./types";
import type {ReceiptPresentation} from "./receiptPresentation";

export type RunStepState = "pending" | "running" | "done" | "failed" | "skipped";
export type RunStep = {id: string; label: string; state: RunStepState; at?: number};
export type RunProgressSteps = {
  steps: RunStep[];
  failedStep?: string;
  cause?: string;
  effect: {debited: "unknown"; source: "receipt"};
};
export type RunProgressSource = {
  executionSource?: "gateway" | "capability_first";
  state?: string;
  error?: string;
  acceptedAt?: number;
  updatedAt?: number;
  modality?: "voice";
  decision?: Record<string, unknown>;
  clarificationState?: "pending" | "resolved" | "abandoned";
  presentation?: ReceiptPresentation;
  events?: CompanionRunProgressEvent[];
  card?: {steps: {label: string; state: "pending" | "running" | "done"}[]};
};
const MAX_CARD_STEPS = 12;

const LABELS = {
  fr: {accepted: "Demande reçue", understood: "Demande comprise", clarify: "Précision demandée",
    execute: "Exécution", answer: "Réponse de Samantha", expired: "Expiré après une inactivité vérifiée.",
    prepare: "Je prépare ta demande"},
  en: {accepted: "Request received", understood: "Request understood", clarify: "Clarification asked",
    execute: "Execution", answer: "Samantha's answer", expired: "Expired after verified inactivity.",
    prepare: "Preparing your request"},
};
/** Technical event labels of the Gateway transport and of tool calls: never a public step (Amine 25/10/2026, point E). */
const TECHNICAL_LABEL = /^(?:(?:Calling|Completed|Running|Using|Tool failed)\s+[A-Za-z0-9_.-]+\.?|Completed\.|Working(?:\.\.\.|…)|Thinking\.\.\.|Started OpenClaw session\.|Prepared context\.|Submitted prompt\.|Model response received\.|Saved run artifacts\.|Run finished\.|Run ended with an error\.|Client connection closed\.|OpenClaw submit failed\.)$/;
const TOOL_EVENT = /^tool\.(?:call|result|error)$/;
const MAX_EVENT_STEPS = 8;
const BUSINESS_STEP_LABELS: Record<string, {fr: string; en: string}> = {
  provider_selection: {fr: "Sélection des fournisseurs", en: "Provider selection"},
  provider_read: {fr: "Lecture des factures", en: "Bill retrieval"},
  verified_aggregation: {fr: "Synthèse vérifiée", en: "Verified summary"},
};
const at = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const safeLabel = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 160
  && !/[\x00-\x1f]/.test(value) && !/^[\[{]/.test(value.trim()) ? value : undefined;

function terminalState(state: string | undefined): RunStepState {
  return state === "done" ? "done" : state === "failed" ? "failed" : state === "running" || state === "queued" ? "running" : "pending";
}

function publishedBusinessSteps(decision: Record<string, unknown> | undefined, locale: "fr" | "en") {
  const selected = decision?.selected;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return [];
  const contract = (selected as Record<string, unknown>).execution_contract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
  const row = contract as Record<string, unknown>;
  if (row.published_steps_scope !== "business_only_no_agent_tool_calls" || !Array.isArray(row.published_steps)) return [];
  const seen = new Set<string>();
  return row.published_steps.slice(0, MAX_EVENT_STEPS).flatMap(value => {
    if (typeof value !== "string" || seen.has(value) || !BUSINESS_STEP_LABELS[value]) return [];
    seen.add(value);
    return [{id: `business-${value}`, label: BUSINESS_STEP_LABELS[value][locale]}];
  });
}

/**
 * Public steps of a Gateway run from its recorded events. A tool call is shown only by the title the agent wrote for it
 * (`arguments.title`) and is done once its result is recorded (an errored call is « skipped », the run's own outcome
 * stays on the answer step). Start-up reads of the context files collapse into one « preparing » line. Untitled tool
 * calls (searches, memory, process polls) and technical transport labels are never shown. Other readable events
 * (business labels) keep the historical rule: done, the last one running while the run is.
 */
function agentEventSteps(events: CompanionRunProgressEvent[], running: boolean, prepareLabel: string): RunStep[] {
  const out: (RunStep & {callIds?: string[]})[] = [];
  const byCall = new Map<string, RunStep & {callIds?: string[]}>();
  const contextCalls = new Set<string>();
  let prepare: (RunStep & {callIds?: string[]}) | undefined;
  let titled = 0;
  const ordered = events.filter(e => e && typeof e.label === "string").slice().sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  for (const event of ordered) {
    if (TOOL_EVENT.test(event.type)) {
      const id = typeof event.callId === "string" && event.callId ? event.callId : undefined;
      if (event.type === "tool.call") {
        const title = safeLabel(event.title?.trim().replace(/\s+/g, " "));
        if (title && !TECHNICAL_LABEL.test(title)) {
          const previous = out[out.length - 1];
          // Identical consecutive steps (a retry under the same title) are one step, in the state of the last attempt.
          if (previous && previous.label === title && previous.id.startsWith("agent-")) {
            previous.state = "running"; if (id) { (previous.callIds ||= []).push(id); byCall.set(id, previous); }
          } else {
            const step = {id: `agent-${++titled}`, label: title, state: "running" as RunStepState, at: at(event.at), callIds: id ? [id] : []};
            out.push(step); if (id) byCall.set(id, step);
          }
        } else if (event.context) {
          if (!prepare) { prepare = {id: "prepare", label: prepareLabel, state: "running", at: at(event.at), callIds: []}; out.push(prepare); }
          if (id) { contextCalls.add(id); prepare.callIds!.push(id); }
        }
      } else if (id) {
        const step = byCall.get(id);
        if (step && step.callIds?.at(-1) === id) step.state = event.type === "tool.error" ? "skipped" : "done";
        if (contextCalls.has(id)) { contextCalls.delete(id); if (prepare && contextCalls.size === 0) prepare.state = "done"; }
      }
      continue;
    }
    const label = safeLabel(event.label);
    if (!label || TECHNICAL_LABEL.test(label)) continue;
    const previous = out[out.length - 1];
    if (previous && previous.label === label) continue;
    out.push({id: `event-${event.seq ?? out.length + 1}`, label, state: "done", at: at(event.at)});
  }
  // Historical rule for readable non-tool events: the last one is running while the run is (nothing finished it).
  const last = out[out.length - 1];
  if (running && last && last.id.startsWith("event-")) last.state = "running";
  // Preparation is over as soon as the agent moved on to a real step.
  if (prepare && out[out.length - 1] !== prepare) prepare.state = "done";
  return out.map(({callIds, ...step}) => step);
}

export function runProgressSteps(run: RunProgressSource): RunProgressSteps | undefined {
  if (run.modality === "voice") return undefined;
  const p = run.presentation;
  const locale = p?.locale === "en" ? "en" : "fr";
  const t = LABELS[locale];
  const accepted = at(run.acceptedAt);
  const ended = run.state === "done" || run.state === "failed" ? at(run.updatedAt) : undefined;
  const steps: RunStep[] = [{id: "accepted", label: t.accepted, state: "done", at: accepted}];
  let failedStep: string | undefined;

  const type = typeof run.decision?.type === "string" ? run.decision.type : undefined;
  const businessSteps = publishedBusinessSteps(run.decision, locale);
  if (run.executionSource === "capability_first" && type) {
    const understoodText = p?.understood?.capability && p.understood.text ? p.understood.text : undefined;
    steps.push({id: "understood", label: understoodText || t.understood, state: "done", at: accepted});
  }
  if (run.executionSource === "capability_first" && type === "CLARIFY") {
    const s: RunStepState = run.clarificationState === "resolved" ? "done"
      : run.clarificationState === "abandoned" ? "failed"
      : run.state === "failed" ? "failed" : "running";
    steps.push({id: "clarify", label: t.clarify, state: s, at: s === "running" ? undefined : ended});
    if (s === "failed") failedStep = t.clarify;
  } else if (businessSteps.length > 0) {
    const terminal = terminalState(run.state);
    businessSteps.forEach((step, index) => {
      const state: RunStepState = terminal === "done" ? "done"
        : terminal === "failed" ? (index === 0 ? "failed" : "skipped")
        : terminal === "running" ? (index === 0 ? "running" : "pending") : "pending";
      steps.push({...step, state, at: state === "done" || state === "failed" ? ended : undefined});
    });
    if (terminal === "failed") failedStep = businessSteps[0].label;
  } else if (run.executionSource === "capability_first") {
      // HS3: a payment handoff ends with its payment request, not with the run that prepared it.
      const pay = p?.payment?.state;
      const s: RunStepState = pay && p?.status === "error" ? "failed"
        : pay && ["awaiting_owner", "executing", "requires_bank_action"].includes(pay) ? "running" : terminalState(run.state);
      steps.push({id: "execute", label: t.execute, state: s, at: s === "done" || s === "failed" ? ended : undefined});
      if (s === "failed") failedStep = p?.failure?.step || t.execute;
  } else if (run.card?.steps?.length) {
    // Gateway runs with the agent's progress card: its steps are written for Amine (user-oriented progress rule) and
    // replace the technical tool events. A terminal run closes the card's open steps without inventing any result.
    const terminal = terminalState(run.state);
    run.card.steps.filter(step => safeLabel(step?.label)).slice(0, MAX_CARD_STEPS).forEach((step, index) => {
      const state: RunStepState = terminal === "done" ? (step.state === "pending" ? "skipped" : "done")
        : terminal === "failed" ? (step.state === "done" ? "done" : step.state === "running" ? "failed" : "skipped")
        : step.state;
      steps.push({id: `card-${index + 1}`, label: step.label, state});
      if (state === "failed" && !failedStep) failedStep = step.label;
    });
    if (run.state === "done") steps.push({id: "answer", label: t.answer, state: "done", at: ended});
    if (run.state === "failed") { steps.push({id: "answer", label: t.answer, state: "failed", at: ended}); failedStep = failedStep || t.answer; }
  } else {
    // Gateway runs without a card (Amine 25/10/2026, point E): the agent's own tool titles, never a tool name, never the
    // start-up context reads (at most one « preparing » line), identical consecutive steps merged, and a finished step
    // never keeps the running icon.
    const running = run.state === "running" || run.state === "queued";
    const eventSteps = agentEventSteps(run.events || [], running, t.prepare).slice(-MAX_EVENT_STEPS);
    if (run.state === "done") for (const step of eventSteps) if (step.state === "running") step.state = "done";
    if (run.state === "failed") for (const step of eventSteps) if (step.state === "running") step.state = "skipped";
    steps.push(...eventSteps);
    if (run.state === "done") steps.push({id: "answer", label: t.answer, state: "done", at: ended});
    if (run.state === "failed") { steps.push({id: "answer", label: t.answer, state: "failed", at: ended}); failedStep = t.answer; }
    if (running && !eventSteps.some(step => step.state === "running")) steps.push({id: "answer", label: t.answer, state: "running"});
  }

  const result: RunProgressSteps = {steps, effect: {debited: "unknown", source: "receipt"}};
  if (failedStep) {
    result.failedStep = failedStep;
    const cause = p?.failure?.reason || (run.error === "run_inactivity_expired" ? t.expired : undefined);
    if (cause) result.cause = cause;
  }
  return result;
}

/** A transport/tool label (« Calling exec. », « Completed read. », « Completed. ») that must not reach Amine as live text. */
export function isTechnicalProgressLabel(label: unknown): boolean {
  return typeof label !== "string" || !label.trim() || TECHNICAL_LABEL.test(label.trim());
}
