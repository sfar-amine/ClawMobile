import crypto from "crypto";
import { readReceiptPresentation, publicDecision } from "./receiptPresentation";
import type { PaymentExecutionResult } from "./paymentTypes";

/**
 * Lot 41 piste 2 (38 C1 à la voix). Pure, closed projection of a capability-owner receipt into
 * the sentences the voice must say verbatim. No routing, no model call, no persistence, no I/O.
 *
 * Sources, in order (never the model's prose, nor selected/quote recomputation):
 *  1. HS3 presentation contract (`presentation.understood`, `presentation.failure`, `alternatives`,
 *     or the same fields at top level as served by /v1/runs) when the owner supplies them;
 *  2. fallback: the capability and parameters of the v2 decision / selected route of the same receipt.
 */

export type VoiceLocale = "fr" | "en";
export type VoiceUnderstood = {
  label: string;
  source: "presentation" | "decision_v2";
  capability: string | null;
  target: string | null;
  intent: string | null;
  route: string | null;
  decisionId: string | null;
};
export type VoiceAlternative = { capability: string; label: string };
export type VoiceSpeech = {
  version: 1;
  locale: VoiceLocale;
  phase: "transaction" | "clarify" | "read_low_confidence" | "failure" | "none";
  understood?: string;
  failure?: string;
  noDebit?: string;
  /** Text the spoken answer must start with, word for word. Null when nothing is imposed. */
  verbatim: string | null;
};

/** Mirrors the Capability Graph trust threshold (plan_trusted: confidence >= 0.6). */
export const HARNESS_TRUST_THRESHOLD = 0.6;
export const VOICE_REALIGNMENT_WINDOW_MS = 120_000;
const HIGH_CONSEQUENCE = new Set(["transaction", "destructive", "sensitive", "external_send"]);
const CLARIFY_STATES = new Set(["needs_clarification", "needs_parameter", "needs_counter"]);
const FAILED_STATES = new Set(["failed", "unavailable", "timeout", "blocked", "effect_unknown", "cancelled_before_admission", "refused", "error"]);

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const SECRET = /\bBearer\s+|\b(?:sk-|ghp_|github_pat_|AKIA|eyJ)[A-Za-z0-9_.-]+|refresh_token|access_token|-----BEGIN|@|[\x00-\x1f]|\b(?:otp|pin|code)\b\W{0,3}\d/i;
const ID = /^[a-z][a-z0-9_.-]{0,159}$/;

/** A sentence that may be spoken: bounded, no secret, no long digit run, not JSON. */
function speakable(v: unknown, max = 200): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max && !SECRET.test(v)
    && (v.match(/\d/g) || []).length < 6 && !/^[\[{]/.test(v.trim());
}
function id(v: unknown): string | null {
  return typeof v === "string" && ID.test(v) ? v : null;
}
function humanize(value: string) {
  return value.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}
export function voiceLocale(value: unknown): VoiceLocale {
  return String(value || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}

function presentationOf(envelope: Record<string, any>) {
  return readReceiptPresentation(envelope) || null;
}

function decisionOf(envelope: Record<string, any>) {
  const raw = obj(envelope.decision) ? envelope.decision : {};
  const d = publicDecision(raw);
  const harness = obj(envelope.harness) ? envelope.harness : {};
  const confidence = [raw.confidence, harness.confidence]
    .find((v) => typeof v === "number" && Number.isFinite(v));
  return {
    type: d?.type || null,
    decisionId: typeof raw.decisionId === "string" && /^[A-Za-z0-9]{8,64}$/.test(raw.decisionId) ? raw.decisionId : null,
    capability: d?.capability || null,
    target: d?.target || null,
    intent: d?.intent || null,
    route: id(raw.route),
    risk: d?.risk || "read",
    confirmation: d?.confirmationRequired === true,
    parameters: d?.parameters || {},
    confidence: confidence as number | undefined,
    shortlist: Array.isArray(harness.shortlist) ? harness.shortlist : [],
  };
}

function resultOf(envelope: Record<string, any>) {
  const execution = obj(envelope.execution) ? envelope.execution : {};
  const result = obj(execution.result) ? execution.result : {};
  return { execution, result };
}

/** « Compris » label: HS3 understood verbatim, else capability + parameters of the v2 decision. */
export function readVoiceUnderstood(envelope: unknown, locale: VoiceLocale = "fr"): VoiceUnderstood | null {
  if (!obj(envelope)) return null;
  const d = decisionOf(envelope);
  const p = presentationOf(envelope);
  const understood = p?.understood || null;
  // HS3 « Compris : … » sentence, spoken verbatim (only its leading « Compris : » becomes « J'ai compris : »).
  const sentenceText = understood && typeof understood.text === "string" ? understood.text.trim() : "";
  const match = /^(?:compris|understood)\s*:\s*(.+)$/iu.exec(sentenceText);
  if (match && speakable(match[1], 240)) {
    return { label: match[1].trim(), source: "presentation", capability: id(understood!.capability) || d.capability,
      target: d.target, intent: d.intent, route: d.route, decisionId: d.decisionId };
  }
  if (understood && speakable(understood.label)) {
    return {
      label: understood.label.trim(),
      source: "presentation",
      capability: id(understood.capability) || d.capability,
      target: d.target, intent: d.intent, route: d.route, decisionId: d.decisionId,
    };
  }
  if (!d.capability) return null;
  const parts = [humanize(d.capability)];
  if (d.intent && humanize(d.intent) !== parts[0]) parts.push(humanize(d.intent));
  if (d.parameters.amountTnd) parts.push(locale === "fr" ? d.parameters.amountTnd.replace(".", ",") + " DT" : d.parameters.amountTnd + " TND");
  return { label: parts.join(" · "), source: "decision_v2", capability: d.capability, target: d.target, intent: d.intent, route: d.route, decisionId: d.decisionId };
}

/** 2–3 other candidates: HS3 alternatives, else the rest of the harness shortlist of the same turn. */
export function readVoiceAlternatives(envelope: unknown, max = 3): VoiceAlternative[] {
  if (!obj(envelope)) return [];
  const d = decisionOf(envelope);
  const p = presentationOf(envelope);
  const seen = new Set<string>(d.capability ? [d.capability] : []);
  const out: VoiceAlternative[] = [];
  const declared = p?.alternatives || null;
  if (declared && declared.length) {
    for (const row of declared) {
      const cap = obj(row) ? id(row.capability) : null;
      if (!cap || seen.has(cap) || !speakable(row.label)) continue;
      seen.add(cap); out.push({ capability: cap, label: row.label.trim() });
      if (out.length >= max) break;
    }
    return out;
  }
  for (const row of d.shortlist) {
    const cap = obj(row) ? id(row.id) : null;
    if (!cap || seen.has(cap) || cap === "engineering.learning_gate") continue;
    seen.add(cap); out.push({ capability: cap, label: humanize(cap) });
    if (out.length >= max) break;
  }
  return out;
}

const REASONS: Record<string, { fr: string; en: string }> = {
  payment_not_submitted: { fr: "le paiement n'a pas été soumis", en: "the payment was not submitted" },
  maxit_live_acceptance_not_armed: { fr: "le paiement réel n'est pas encore activé", en: "live payment is not enabled yet" },
  maxit_order_creation_failed: { fr: "la commande n'a pas pu être créée chez l'opérateur", en: "the operator could not create the order" },
  payment_card_not_ready: { fr: "la carte de paiement n'est pas prête", en: "the payment card is not ready" },
  capability_bridge_unavailable: { fr: "le service Claw n'est pas joignable", en: "the Claw service is unreachable" },
  device_timeout: { fr: "le téléphone n'a pas répondu à temps", en: "the phone did not answer in time" },
  timeout: { fr: "le délai a été dépassé", en: "it took too long" },
  selected_not_ready: { fr: "ce parcours n'est pas prêt pour le moment", en: "this route is not ready right now" },
  required_capability_not_ready: { fr: "ce parcours n'est pas prêt pour le moment", en: "this route is not ready right now" },
  selected_not_authorized: { fr: "ce parcours n'est pas autorisé ici", en: "this route is not allowed here" },
  cancelled_before_admission: { fr: "la demande a été annulée avant son exécution", en: "the request was cancelled before it ran" },
  effect_unknown: { fr: "le résultat n'est pas confirmé, vérifie avant de réessayer", en: "the outcome is not confirmed, check before retrying" },
  voice_session_not_owned: { fr: "la session vocale a changé pendant la demande", en: "the voice session changed during the request" },
};
const STEPS: Record<string, { fr: string; en: string }> = {
  admission: { fr: "préparation", en: "preparation" },
  execution: { fr: "exécution", en: "execution" },
  payment: { fr: "paiement", en: "payment" },
};

function codesOf(envelope: Record<string, any>): string[] {
  const { execution, result } = resultOf(envelope);
  const payment = obj(result.payment) ? result.payment : obj(envelope.payment) ? envelope.payment : {};
  return [result.reasonCode, result.reasonDetail, payment.reasonCode, payment.reasonDetail, result.reason, execution.reason, execution.error,
    envelope.reason, envelope.error, execution.state, result.state, payment.state]
    .filter((v): v is string => typeof v === "string" && /^[a-z][a-z0-9_]{1,80}$/.test(v));
}

/** « Rien n'a été débité » only when the receipt itself proves it (blocked / payment_not_submitted). */
export function receiptProvesNoDebit(envelope: unknown): boolean {
  if (!obj(envelope)) return false;
  const p = presentationOf(envelope);
  const { execution, result } = resultOf(envelope);
  const rows = [result, obj(result.payment) ? result.payment : null, obj(envelope.payment) ? envelope.payment : null,
    obj(execution.payment) ? execution.payment : null].filter(obj) as Record<string, unknown>[];
  // Canonical S24 trace can establish a dispatch even when the public boolean is
  // absent. Its absence must never turn a contradictory not-submitted code into proof.
  const submitted = rows.some((row) => {
    if (row.financialSubmissionAttempted === true) return true;
    return [row.trace, row.timeline].some((events) => Array.isArray(events)
      && (events.length > 160 || events.some((event) => obj(event) && event.stage === "financial_dispatch_committed")));
  });
  if (submitted) return false;
  if (p?.failure?.notDone?.code === "payment_not_submitted") return true;
  return rows.some((row) => row.reasonCode === "payment_not_submitted");
}

function failureOf(envelope: Record<string, any>, locale: VoiceLocale): { step: string; reason: string } | null {
  const p = presentationOf(envelope);
  const declared = p?.status === "error" ? p.failure : null;
  if (declared && speakable(declared.step) && speakable(declared.reason, 240)) {
    const unknownStep = declared.stepId === "unknown" || /non établie|not established/i.test(declared.step);
    return { step: unknownStep ? "" : declared.step.trim(), reason: declared.reason.trim() };
  }
  const { execution, result } = resultOf(envelope);
  const paymentRow = obj(result.payment) ? result.payment : obj(envelope.payment) ? envelope.payment : {};
  const failed = envelope.success === false || FAILED_STATES.has(String(execution.state || "")) || FAILED_STATES.has(String(result.state || ""))
    || FAILED_STATES.has(String(paymentRow.state || "")) || result.ok === false;
  if (!failed) return null;
  const codes = codesOf(envelope);
  const d = decisionOf(envelope);
  const payment = d.risk === "transaction" || String(d.capability || "").startsWith("payment.") || Object.keys(paymentRow).length > 0
    || codes.some((c) => c.startsWith("payment_")) || receiptProvesNoDebit(envelope);
  const stepKey = execution.state === "cancelled_before_admission" ? "admission" : payment ? "payment" : "execution";
  // Precise detail first (reasonDetail), then the grouped code; never speak an unmapped code.
  const ordered = [result.reasonDetail, obj(result.payment) ? result.payment.reasonDetail : null, ...codes];
  const known = ordered.find((c) => typeof c === "string" && REASONS[c]);
  const reason = known ? REASONS[known as string][locale]
    : locale === "fr" ? "la cause n'est pas établie par le reçu" : "the receipt does not establish the cause";
  return { step: STEPS[stepKey][locale], reason };
}

function isClarify(envelope: Record<string, any>, d: ReturnType<typeof decisionOf>) {
  const { execution, result } = resultOf(envelope);
  return d.type === "CLARIFY" || CLARIFY_STATES.has(String(execution.state || "")) || CLARIFY_STATES.has(String(result.state || ""))
    || CLARIFY_STATES.has(String(envelope.state || ""));
}

function sentence(text: string) {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : t + ".";
}

/** Imposed spoken text for one receipt (V1 + V3). The model only verbalizes what follows it. */
export function planVoiceSpeech(envelope: unknown, options: { locale?: unknown; threshold?: number } = {}): VoiceSpeech {
  const fallbackLocale = voiceLocale(options.locale);
  if (!obj(envelope)) return { version: 1, locale: fallbackLocale, phase: "none", verbatim: null };
  const p = presentationOf(envelope);
  const locale: VoiceLocale = p && (p.locale === "fr" || p.locale === "en") ? p.locale : fallbackLocale;
  const threshold = typeof options.threshold === "number" && options.threshold >= 0 && options.threshold <= 1 ? options.threshold : HARNESS_TRUST_THRESHOLD;
  const d = decisionOf(envelope);
  const fail = failureOf(envelope, locale);
  const clarify = !fail && isClarify(envelope, d);
  const transaction = HIGH_CONSEQUENCE.has(d.risk) || d.confirmation;
  const lowConfidence = d.confidence === undefined || d.confidence < threshold;
  const announce = transaction || clarify || lowConfidence;
  const phase: VoiceSpeech["phase"] = fail ? "failure" : transaction ? "transaction" : clarify ? "clarify" : lowConfidence ? "read_low_confidence" : "none";
  const understood = announce ? readVoiceUnderstood(envelope, locale) : null;
  const out: VoiceSpeech = { version: 1, locale, phase, verbatim: null };
  if (understood) out.understood = sentence((locale === "fr" ? "J'ai compris : " : "I understood: ") + understood.label);
  if (fail) {
    const reason = fail.reason.replace(/[.。]+$/u, "");
    const lower = reason.charAt(0).toLocaleLowerCase(locale) + reason.slice(1);
    out.failure = locale === "fr"
      ? sentence(fail.step ? `Ça n'a pas abouti à l'étape « ${fail.step} » : ${lower}` : `Ça n'a pas abouti : ${lower}`)
      : sentence(fail.step ? `It did not go through at the “${fail.step}” step: ${lower}` : `It did not go through: ${lower}`);
    if (receiptProvesNoDebit(envelope)) out.noDebit = locale === "fr" ? "Rien n'a été débité." : "Nothing was charged.";
  }
  const parts = [out.understood, out.failure, out.noDebit].filter(Boolean) as string[];
  out.verbatim = parts.length ? parts.join(" ") : null;
  return out;
}

// ---------------------------------------------------------------------------------------------
// V2 — « Non, c'est pas ça » : deterministic, versioned gesture list (never a model call).

/** Versioned correction gestures. derja/arabizi are authored until Amine supplies his own forms. */
export const VOICE_REALIGNMENT_PHRASES = Object.freeze({
  version: "voice-realign-v1-20261011",
  windowMs: VOICE_REALIGNMENT_WINDOW_MS,
  provenance: { fr: "authored", en: "authored", derja: "authored_pending_amine", arabizi: "authored_pending_amine" },
  fr: Object.freeze([
    "non c'est pas ça", "non ce n'est pas ça", "c'est pas ça", "ce n'est pas ça", "non pas ça", "pas ça",
    "non c'est pas ce que je voulais", "c'est pas ce que je voulais", "ce n'est pas ce que je voulais",
    "c'est pas ce que je voulais dire", "ce n'est pas ce que je voulais dire", "tu as mal compris", "t'as mal compris",
    "non tu as mal compris", "non t'as mal compris", "non c'est pas ça du tout", "c'est pas du tout ça",
  ]),
  en: Object.freeze([
    "no that's not it", "that's not it", "no that is not it", "that is not it", "not that", "no not that",
    "that's not what i meant", "that is not what i meant", "that's not what i asked", "you misunderstood",
    "no you misunderstood", "wrong one",
  ]),
  derja: Object.freeze(["لا موش هكا", "موش هكا", "ماهوش هكا", "لا ماهوش هكا", "موش هذا", "ما فهمتنيش", "لا ما فهمتنيش"]),
  arabizi: Object.freeze([
    "le mouch haka", "la mouch haka", "mouch haka", "mech haka", "le mech haka", "la mech haka", "mahouch haka",
    "le mahouch haka", "mouch hedha", "mech hedha", "ma fhemtnich", "ma fhemtnech", "le ma fhemtnich",
  ]),
});

const FILLERS = /^(?:(?:samantha|euh+|hmm+|bah|ben|ok|okay|alors|non non|no no|la la|le le)\s+)+|(?:\s+(?:samantha|stp|s'il te plaît|please|enfin))+$/u;

export function gestureKey(value: string): string {
  let t = value.normalize("NFKC").toLowerCase().replace(/[’‘`´]/g, "'");
  t = t.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
  t = t.replace(/[.,!?;:«»"“”()،؟…-]+/gu, " ").replace(/'/g, " ").replace(/\s+/g, " ").trim();
  let previous = "";
  while (previous !== t) { previous = t; t = t.replace(FILLERS, "").trim(); }
  return t;
}

const GESTURES = new Set(
  (["fr", "en", "derja", "arabizi"] as const).flatMap((k) => VOICE_REALIGNMENT_PHRASES[k]).map(gestureKey),
);

/** True only for a listed gesture spoken within the window after a voice turn. */
export function isVoiceRealignment(text: unknown, lastTurnAt: unknown, now = Date.now()): boolean {
  if (typeof text !== "string" || text.length > 160 || typeof lastTurnAt !== "number" || !Number.isFinite(lastTurnAt)) return false;
  if (now < lastTurnAt || now - lastTurnAt > VOICE_REALIGNMENT_WINDOW_MS) return false;
  return GESTURES.has(gestureKey(text));
}

/** Bounded projection kept in memory for the realignment window: no transcript, no result payload. */
export type VoiceTurnContext = {
  at: number;
  taskId: string;
  understood: VoiceUnderstood;
  alternatives: VoiceAlternative[];
  locale: VoiceLocale;
  offeredAt?: number;
};

export function voiceTurnContext(envelope: unknown, request: string, options: { locale?: unknown; now?: number; scope?: string } = {}): VoiceTurnContext | null {
  const locale = voiceLocale(options.locale);
  const understood = readVoiceUnderstood(envelope, locale);
  if (!understood || !understood.capability) return null;
  // Stable task id: the decision id when present, else a digest (never the text itself).
  const taskId = understood.decisionId ? "voice-" + understood.decisionId.slice(0, 40)
    : "voice-" + crypto.createHash("sha256").update(JSON.stringify([options.scope || "", understood.capability, request])).digest("hex").slice(0, 32);
  return { at: options.now ?? Date.now(), taskId, understood, alternatives: readVoiceAlternatives(envelope), locale };
}

/** Same guided realignment as the « Ce n'est pas ça » button: recall, 2–3 candidates, free answer. */
export function realignmentSpeech(context: VoiceTurnContext): string {
  const fr = context.locale === "fr";
  const recall = (fr ? "J'avais compris : " : "I had understood: ") + context.understood.label + ".";
  const labels = context.alternatives.slice(0, 3).map((a) => a.label);
  const joined = labels.length <= 1 ? labels.join("") : labels.slice(0, -1).join(", ") + (fr ? " ou " : " or ") + labels[labels.length - 1];
  const offer = labels.length ? (fr ? ` Tu voulais plutôt : ${joined} ?` : ` Did you rather mean: ${joined}?`) : "";
  const free = fr ? " Tu peux aussi me le dire avec tes mots." : " You can also tell me in your own words.";
  return recall + offer + free;
}

const ORDINALS: Record<string, number> = {
  "1": 0, "un": 0, "une": 0, "premier": 0, "premiere": 0, "le premier": 0, "la premiere": 0, "first": 0, "the first": 0, "one": 0,
  "2": 1, "deux": 1, "deuxieme": 1, "le deuxieme": 1, "la deuxieme": 1, "second": 1, "the second": 1, "two": 1,
  "3": 2, "trois": 2, "troisieme": 2, "le troisieme": 2, "la troisieme": 2, "third": 2, "the third": 2, "three": 2,
};

/** Ordinal or exact label answer after a realignment → that candidate's label as the next request. */
export function realignmentChoice(answer: unknown, context: VoiceTurnContext | null): VoiceAlternative | null {
  if (!context || typeof answer !== "string" || answer.length > 160) return null;
  const key = gestureKey(answer);
  const index = ORDINALS[key];
  if (index !== undefined) return context.alternatives[index] || null;
  return context.alternatives.find((a) => gestureKey(a.label) === key) || null;
}

/** Round Learning payload (engineering.learning_gate capture-round): no transcript, no secret. */
export function realignmentRoundPayload(context: VoiceTurnContext, stage: "requested" | "resolved", corrected?: { capability: string | null; route: string | null }) {
  const u = context.understood;
  if (!u.capability || !u.target || !u.intent) return null;
  const resolved = stage === "resolved" && corrected?.capability && corrected.capability !== u.capability;
  if (stage === "resolved" && !resolved) return null;
  return {
    round_id: context.taskId + (stage === "requested" ? ":realign" : ":realigned"),
    task_id: context.taskId,
    capability: u.capability,
    target: u.target,
    intent: u.intent,
    outcome: "failed",
    signals: resolved ? ["intent_refined", "user_correction"] : ["user_correction"],
    authority: "owner_correction",
    observation: resolved
      ? "Voice realignment: the owner corrected the understood capability and chose another one."
      : "Voice realignment requested by a deterministic correction gesture after the turn.",
    suggestion: resolved ? "Associate the original phrasing with the corrected capability; keep the previous resolution as a counter-example." : "Treat the previous resolution of this phrasing as a counter-example until qualified.",
    evidence: [
      "voice_gesture:" + VOICE_REALIGNMENT_PHRASES.version,
      ...(u.decisionId ? ["decision:" + u.decisionId] : []),
      "understood_source:" + u.source,
    ],
    route_before: u.route || "",
    route_after: resolved ? corrected?.route || corrected?.capability || "" : "",
    source_before: u.capability,
    source_after: resolved ? corrected?.capability || "" : "",
  };
}

/** Projection added to a voice receipt so every renderer reads the same imposed text. */
export function voiceReceiptProjection(envelope: unknown, locale: unknown) {
  const speech = planVoiceSpeech(envelope, { locale });
  return speech.verbatim ? { voice: speech } : {};
}
