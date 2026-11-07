/** HS5 — run steps derived on read from existing receipts only (runs.json run, decision,
 * HS3 presentation, Gateway progress events). Nothing is stored, invented or simulated. */
import type {CompanionRunProgressEvent} from "./types";
import type {ReceiptPresentation} from "./receiptPresentation";

export type RunStepState = "pending" | "running" | "done" | "failed" | "skipped";
/** `durationMs`: measured from the step's own recorded boundaries (start → result), never estimated. */
export type RunStep = {id: string; label: string; state: RunStepState; at?: number; durationMs?: number};
export type RunProgressSteps = {
  steps: RunStep[];
  failedStep?: string;
  cause?: string;
  effect: {debited: "unknown"; source: "receipt"};
  /** Terminal run: accepted → settled, from the run's own receipt timestamps. */
  totalMs?: number;
  /** Sanitized headers of the model's own reasoning summary (journey « See the reasoning »), never its body. */
  reasoning?: string[];
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
  reasoning?: unknown;
  /** Amine stopped the run (journey Cancel): its end is that stop, not a failed step. */
  stopped?: boolean;
};
const MAX_CARD_STEPS = 12;

const LABELS = {
  fr: {accepted: "Demande reçue", understood: "Demande comprise", clarify: "Précision demandée",
    execute: "Exécution", answer: "Réponse de Samantha", expired: "Expiré après une inactivité vérifiée.",
    prepare: "Je prépare ta demande", stopped: "Arrêtée à ta demande"},
  en: {accepted: "Request received", understood: "Request understood", clarify: "Clarification asked",
    execute: "Execution", answer: "Samantha's answer", expired: "Expired after verified inactivity.",
    prepare: "Preparing your request", stopped: "Stopped at your request"},
};
/** Technical event labels of the Gateway transport and of tool calls: never a public step (Amine 25/10/2026, point E). */
const TECHNICAL_LABEL = /^(?:(?:Calling|Completed|Running|Using|Tool failed)\s+[A-Za-z0-9_.-]+\.?|Completed\.|Working(?:\.\.\.|…)|Thinking\.\.\.|Started OpenClaw session\.|Prepared context\.|Submitted prompt\.|Model response received\.|Saved run artifacts\.|Run finished\.|Run ended with an error\.|Client connection closed\.|OpenClaw submit failed\.)$/;
const PRIVATE_TECHNICAL_TITLE = /(?:\b(?:exec|read|tool_search|tool_call|memory_search)\b|(?:^|\s)(?:~\/|\/|[A-Za-z]:\\)|\b[\w.-]+\.(?:md|json|py|sh|ts|sqlite)\b|`)/i;
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
        if (event.context) {
          if (!prepare) { prepare = {id: "prepare", label: prepareLabel, state: "running", at: at(event.at), callIds: []}; out.push(prepare); }
          if (id) { contextCalls.add(id); prepare.callIds!.push(id); }
        } else if (title && !TECHNICAL_LABEL.test(title) && !PRIVATE_TECHNICAL_TITLE.test(title)) {
          const previous = out[out.length - 1];
          // Identical consecutive steps (a retry under the same title) are one step, in the state of the last attempt.
          if (previous && previous.label === title && previous.id.startsWith("agent-")) {
            previous.state = "running"; if (id) { (previous.callIds ||= []).push(id); byCall.set(id, previous); }
          } else {
            const step = {id: `agent-${++titled}`, label: title, state: "running" as RunStepState, at: at(event.at), callIds: id ? [id] : []};
            out.push(step); if (id) byCall.set(id, step);
          }
        }
      } else if (id) {
        const step = byCall.get(id);
        if (step && step.callIds?.at(-1) === id) {
          step.state = event.type === "tool.error" ? "skipped" : "done";
          // First start of the (merged) step → its last result, both recorded by the observer.
          const ended = at(event.at);
          if (ended !== undefined && step.at !== undefined && ended >= step.at) step.durationMs = ended - step.at;
        }
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

/** Latest recorded tool result of the run (the answer is written after it), else undefined. */
function lastToolBoundary(events: CompanionRunProgressEvent[] | undefined): number | undefined {
  let last: number | undefined;
  for (const event of events || []) {
    if (event?.type !== "tool.result" && event?.type !== "tool.error") continue;
    const value = at(event.at);
    if (value !== undefined && (last === undefined || value > last)) last = value;
  }
  return last;
}
const span = (from: number | undefined, to: number | undefined) =>
  from !== undefined && to !== undefined && to >= from && to - from <= 86_400_000 ? to - from : undefined;

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
      const executeMs = s === "done" || s === "failed" ? span(accepted, ended) : undefined;
      steps.push({id: "execute", label: t.execute, state: s, at: s === "done" || s === "failed" ? ended : undefined,
        ...(executeMs !== undefined ? {durationMs: executeMs} : {})});
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
    if (run.state === "failed" && run.stopped) {
      steps.push({id: "answer", label: t.stopped, state: "skipped", at: ended});
      return {steps, effect: {debited: "unknown", source: "receipt"}, ...(span(accepted, ended) !== undefined ? {totalMs: span(accepted, ended)} : {}),
        ...(readThoughts(run.reasoning).length ? {reasoning: readThoughts(run.reasoning)} : {})};
    }
    // The answer is written after the last tool result (or from the start when no tool ran).
    const answerMs = span(lastToolBoundary(run.events) ?? accepted, ended);
    if (run.state === "done") steps.push({id: "answer", label: t.answer, state: "done", at: ended, ...(answerMs !== undefined ? {durationMs: answerMs} : {})});
    if (run.state === "failed") { steps.push({id: "answer", label: t.answer, state: "failed", at: ended}); failedStep = t.answer; }
    if (running && !eventSteps.some(step => step.state === "running")) steps.push({id: "answer", label: t.answer, state: "running"});
  }

  const result: RunProgressSteps = {steps, effect: {debited: "unknown", source: "receipt"}};
  const totalMs = span(accepted, ended);
  if (totalMs !== undefined) result.totalMs = totalMs;
  const reasoning = readThoughts(run.reasoning);
  if (reasoning.length) result.reasoning = reasoning;
  if (failedStep) {
    result.failedStep = failedStep;
    const cause = p?.failure?.reason || (run.error === "run_inactivity_expired" ? t.expired : undefined);
    if (cause) result.cause = cause;
  }
  return result;
}

/**
 * Waiting cues of Samantha Voix (Amine 31/10/2026, « go pour tout »): the latest typed Samantha tool a run started, so
 * the voice can say once what is being done (« Je regarde tes factures. »). Only the tool name and its action, never a
 * parameter, an argument or a result. Discovery (`samantha_catalogue`) is not an activity.
 */
export type RunActivity = {tool: string; action?: string; at?: number};
const TYPED_TOOL = /^samantha_[a-z0-9_]{1,100}$/;
const TYPED_ACTION = /^[a-z][a-z0-9_.-]{0,127}$/;
const NOT_AN_ACTIVITY = new Set(["samantha_catalogue"]);

/**
 * The model also reaches a plugin tool through the Gateway's discovery wrapper: `tool_call` with
 * `{id: "openclaw:<plugin>:<tool>", args: {...}}` (S24 transcripts of 07/11/2026). The wrapped tool and its own
 * arguments are the call; anything else is returned unchanged.
 */
const WRAPPED_TOOL = /^openclaw:[a-z0-9-]{1,80}:([a-z][a-z0-9_]{1,100})$/;
export function unwrapToolCall(name: unknown, args: unknown): {name: unknown; args: unknown} {
  if (name !== "tool_call" || !args || typeof args !== "object" || Array.isArray(args)) return {name, args};
  const wrapped = args as Record<string, unknown>;
  const inner = typeof wrapped.id === "string" ? WRAPPED_TOOL.exec(wrapped.id)?.[1] : undefined;
  return inner ? {name: inner, args: wrapped.args} : {name, args};
}

/** Activity of a typed tool call seen on the Gateway stream (`data.name`, `data.args.action`), or undefined. */
export function typedToolActivity(rawName: unknown, rawArgs: unknown, at?: number): RunActivity | undefined {
  const {name, args} = unwrapToolCall(rawName, rawArgs);
  if (typeof name !== "string" || !TYPED_TOOL.test(name) || NOT_AN_ACTIVITY.has(name)) return undefined;
  const action = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).action : undefined;
  return {tool: name, ...(typeof action === "string" && TYPED_ACTION.test(action) ? {action} : {}),
    ...(typeof at === "number" && Number.isSafeInteger(at) && at > 0 ? {at} : {})};
}

/** A stored or received activity, validated field by field; anything else is dropped. */
export function readRunActivity(value: unknown): RunActivity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  return typedToolActivity(v.tool, {action: v.action}, typeof v.at === "number" ? v.at : undefined);
}

/**
 * The run's current activity: the one recorded by the Gateway observer, else the latest typed tool call of its
 * transcript events (`Calling samantha_….`, action read from the bounded argument summary).
 */
export function runActivity(progress: {activity?: unknown; events?: CompanionRunProgressEvent[]} | undefined): RunActivity | undefined {
  const recorded = readRunActivity(progress?.activity);
  if (recorded) return recorded;
  const events = Array.isArray(progress?.events) ? progress!.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "tool.call" || typeof event.label !== "string") continue;
    const name = /^Calling (samantha_[a-z0-9_]{1,100})\.$/.exec(event.label)?.[1];
    if (!name || NOT_AN_ACTIVITY.has(name)) continue;
    const action = typeof event.detail === "string" ? /"action"\s*:\s*"([a-z][a-z0-9_.-]{0,127})"/.exec(event.detail)?.[1] : undefined;
    return typedToolActivity(name, {action}, event.at);
  }
  return undefined;
}

/** A transport/tool label (« Calling exec. », « Completed read. », « Completed. ») that must not reach Amine as live text. */
export function isTechnicalProgressLabel(label: unknown): boolean {
  return typeof label !== "string" || !label.trim() || TECHNICAL_LABEL.test(label.trim());
}

/**
 * Journey steps (Amine 07/11/2026): what Samantha is doing, in French, from the tool the brain started and its action
 * only. Never a tool name, an argument or a result (rule of 25/10). Internal tools (files, shell, discovery, sessions)
 * return undefined and stay invisible.
 */
const NOT_A_STEP = new Set(["samantha_catalogue", "samantha_brain"]);
const BILLING_PROVIDER: Record<string, string> = {samantha_steg: " STEG", samantha_sonede: " SONEDE", samantha_topnet: " Topnet"};
export function publicToolLabel(rawName: unknown, rawArgs: unknown): string | undefined {
  const {name, args} = unwrapToolCall(rawName, rawArgs);
  if (typeof name !== "string") return undefined;
  const raw = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).action : undefined;
  const action = typeof raw === "string" && TYPED_ACTION.test(raw) ? raw : "";
  if (name === "web_search") return "Je cherche sur le web";
  if (name === "web_fetch") return "Je lis une page web";
  if (name === "memory_search" || name === "memory_get") return "Je consulte ma mémoire";
  if (/^(?:android|adb)_[a-z0-9_]{1,80}$/.test(name)) return "J’utilise ton téléphone";
  if (!TYPED_TOOL.test(name) || NOT_A_STEP.has(name)) return undefined;
  if (action === "cancel") return "J’annule l’action en attente";
  if (name === "samantha_agenda") {
    if (action === "agenda.event.create") return "J’ajoute l’événement à ton agenda";
    if (action === "agenda.event.update") return "Je modifie l’événement de ton agenda";
    if (action === "agenda.event.delete") return "Je supprime l’événement de ton agenda";
    if (action.startsWith("agenda.reminder.")) return "Je programme le rappel";
    return "Je consulte ton agenda";
  }
  if (name === "samantha_maxit_tunisie") {
    if (action === "telecom.usage") return "Je lis ta consommation Orange";
    if (/balance/.test(action)) return "Je lis ton solde Orange";
    if (/topup|recharge/.test(action)) return "Je prépare la recharge Orange";
    return "Je consulte ton compte Orange";
  }
  if (name === "samantha_utility_billing" || BILLING_PROVIDER[name]) {
    const provider = BILLING_PROVIDER[name] || "";
    return action === "billing.pay" ? "Je prépare le paiement" + provider : "Je regarde tes factures" + provider;
  }
  if (name === "samantha_pulse") {
    const pulse: Record<string, string> = {"finance.ca": "Je lis le chiffre d’affaires dans Pulse", "project.search": "Je cherche le projet dans Pulse",
      "project.create": "Je crée le projet dans Pulse", "project.order": "J’enregistre le commandé dans Pulse",
      "offer.search": "Je cherche l’offre dans Pulse", "offer.create": "Je crée l’offre dans Pulse"};
    if (pulse[action]) return pulse[action];
    if (action.startsWith("cra.")) return "Je vérifie les CRA dans Pulse";
    if (/^project\.(?:team|forecast|phase)/.test(action)) return "Je mets à jour le projet dans Pulse";
    return "Je consulte Pulse";
  }
  if (name === "samantha_whatsapp") return action === "messaging.send" ? "J’envoie le message WhatsApp" : "Je prépare le message WhatsApp";
  if (name === "samantha_web") return "Je cherche sur le web";
  if (name.startsWith("samantha_laptop")) return "Je vérifie ton PC";
  if (name === "samantha_device_assistance" || name === "samantha_android") {
    if (action.startsWith("device.sms.")) return "Je lis tes derniers SMS";
    if (action.startsWith("device.photos.")) return "Je regarde tes photos";
    if (action === "device.alarm.next") return "Je regarde ton prochain réveil";
    if (action.startsWith("device.alarm.")) return "Je règle le réveil";
    if (action === "device.timer.cancel") return "J’arrête le minuteur";
    if (action.startsWith("device.timer.")) return "Je lance le minuteur";
    if (action === "device.app.open") return "J’ouvre l’application";
    if (action === "device.settings.open") return "J’ouvre les réglages";
    if (action.startsWith("device.screenshot.")) return "Je fais une capture d’écran";
    if (action === "device.status.read" || action.startsWith("device.battery")) return "Je lis l’état du téléphone";
    if (action.endsWith(".set")) return "Je règle ton téléphone";
    return "J’utilise ton téléphone";
  }
  return "Je traite ta demande";
}

/**
 * « See the reasoning » (Amine 07/11/2026): the model's reasoning summary arrives on the Gateway `thinking` stream as
 * `**Header**` lines followed by a body (S24: gpt-5.6-sol, « **Identifying need for call balances** »). Only the
 * headers are kept, and only those without anything technical or identifying (identifiers, paths, files, links,
 * long digit runs); the body is never kept. At most six, oldest dropped first.
 */
const MAX_THOUGHTS = 6;
const THOUGHT_TECHNICAL = /(?:[A-Za-z0-9]_[A-Za-z0-9]|[`{}\[\]<>|\\@#$]|https?:|www\.|(?:^|\s)~?\/|\b[\w-]+\.(?:md|json|py|sh|ts|js|mjs|cjs|sqlite|kt|apk|txt)\b|\b(?:samantha|openclaw|claw|companion|gateway)\b|\d{6,})/i;
const THOUGHT_CAMEL_CASE = /\b[a-z]+[A-Z][A-Za-z]*\b/;
function cleanThought(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length >= 3 && text.length <= 120 && !/[\x00-\x1f]/.test(text) && !THOUGHT_TECHNICAL.test(text) && !THOUGHT_CAMEL_CASE.test(text) ? text : undefined;
}
export function reasoningThoughts(text: unknown): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  for (const match of text.slice(0, 20000).matchAll(/\*\*([^*\n]{1,160})\*\*/g)) {
    const thought = cleanThought(match[1]);
    if (thought && !out.includes(thought)) out.push(thought);
  }
  return out.slice(-MAX_THOUGHTS);
}
export function mergeThoughts(previous: unknown, next: string[]): string[] {
  const out = readThoughts(previous);
  for (const thought of next) if (!out.includes(thought)) out.push(thought);
  return out.slice(-MAX_THOUGHTS);
}
/** A stored or received list, validated item by item; anything else is dropped. */
export function readThoughts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(-MAX_THOUGHTS)) { const thought = cleanThought(item); if (thought && !out.includes(thought)) out.push(thought); }
  return out;
}
