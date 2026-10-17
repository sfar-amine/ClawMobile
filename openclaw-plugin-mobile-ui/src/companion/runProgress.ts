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
};

const LABELS = {
  fr: {accepted: "Demande reçue", understood: "Demande comprise", clarify: "Précision demandée",
    execute: "Exécution", answer: "Réponse de Samantha", expired: "Expiré après une inactivité vérifiée."},
  en: {accepted: "Request received", understood: "Request understood", clarify: "Clarification asked",
    execute: "Execution", answer: "Samantha's answer", expired: "Expired after verified inactivity."},
};
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
  } else {
    // Gateway runs: each recorded progress event is a real step; the last one is running while the run is.
    const events = (run.events || []).filter(e => safeLabel(e?.label)).slice(-MAX_EVENT_STEPS);
    const running = run.state === "running" || run.state === "queued";
    events.forEach((event, index) => {
      const last = index === events.length - 1;
      steps.push({id: `event-${event.seq ?? index + 1}`, label: event.label,
        state: last && running ? "running" : "done", at: at(event.at)});
    });
    if (run.state === "done") steps.push({id: "answer", label: t.answer, state: "done", at: ended});
    if (run.state === "failed") { steps.push({id: "answer", label: t.answer, state: "failed", at: ended}); failedStep = t.answer; }
    if (running && events.length === 0) steps.push({id: "answer", label: t.answer, state: "running"});
  }

  const result: RunProgressSteps = {steps, effect: {debited: "unknown", source: "receipt"}};
  if (failedStep) {
    result.failedStep = failedStep;
    const cause = p?.failure?.reason || (run.error === "run_inactivity_expired" ? t.expired : undefined);
    if (cause) result.cause = cause;
  }
  return result;
}
