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
const at = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const safeLabel = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 160
  && !/[\x00-\x1f]/.test(value) && !/^[\[{]/.test(value.trim()) ? value : undefined;

function terminalState(state: string | undefined): RunStepState {
  return state === "done" ? "done" : state === "failed" ? "failed" : state === "running" || state === "queued" ? "running" : "pending";
}

export function runProgressSteps(run: RunProgressSource): RunProgressSteps | undefined {
  if (run.modality === "voice") return undefined;
  const p = run.presentation;
  const t = LABELS[p?.locale === "en" ? "en" : "fr"];
  const accepted = at(run.acceptedAt);
  const ended = run.state === "done" || run.state === "failed" ? at(run.updatedAt) : undefined;
  const steps: RunStep[] = [{id: "accepted", label: t.accepted, state: "done", at: accepted}];
  let failedStep: string | undefined;

  if (run.executionSource === "capability_first") {
    const type = typeof run.decision?.type === "string" ? run.decision.type : undefined;
    if (type) {
      const understoodText = p?.understood?.capability && p.understood.text ? p.understood.text : undefined;
      steps.push({id: "understood", label: understoodText || t.understood, state: "done", at: accepted});
    }
    if (type === "CLARIFY") {
      const s: RunStepState = run.clarificationState === "resolved" ? "done"
        : run.clarificationState === "abandoned" ? "failed"
        : run.state === "failed" ? "failed" : "running";
      steps.push({id: "clarify", label: t.clarify, state: s, at: s === "running" ? undefined : ended});
      if (s === "failed") failedStep = t.clarify;
    } else {
      const s = terminalState(run.state);
      steps.push({id: "execute", label: t.execute, state: s, at: s === "done" || s === "failed" ? ended : undefined});
      if (s === "failed") failedStep = p?.failure?.step || t.execute;
    }
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
