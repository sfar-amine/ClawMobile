import crypto from "crypto";
import {
  VOICE_REALIGNMENT_PHRASES, VOICE_REALIGNMENT_WINDOW_MS, gestureKey, isVoiceRealignment,
  readVoiceUnderstood, realignmentChoice, realignmentRoundPayload, realignmentSpeech, voiceLocale, voiceReceiptProjection,
  voiceTurnContext, type VoiceTurnContext,
} from "./voiceUnderstanding";
import { captureVoiceRound, type RoundCaptureResult, type RoundCaptureRunner } from "./voiceRoundLearning";
import {publicDecision} from "./receiptPresentation";

/**
 * Ephemeral « Compris / Ce n'est pas ça » state of the single Claw Live owner (one voice owner at
 * a time). In memory only, one slot, 2-minute window, cleared when the voice owner detaches.
 * It keeps a digest of the last request, never its text; no audio, no transcript, no store.
 */
export class VoiceUnderstandingState {
  private context: (VoiceTurnContext & { key: string }) | null = null;
  private lastTurnKey: string | undefined;
  constructor(private readonly now: () => number = () => Date.now()) {}

  static key(request: string) {
    return crypto.createHash("sha256").update(gestureKey(String(request || ""))).digest("hex").slice(0, 24);
  }
  clear() { this.context = null; this.lastTurnKey = undefined; }

  private live(): (VoiceTurnContext & { key: string }) | null {
    const c = this.context;
    if (!c) return null;
    const anchor = c.offeredAt ?? c.at;
    if (this.now() - anchor > VOICE_REALIGNMENT_WINDOW_MS) { this.context = null; return null; }
    return c;
  }
  /** Context a correction gesture refers to: the last executed turn, if it is the previous turn heard. */
  gestureTarget(request: string): VoiceTurnContext | null {
    const c = this.live();
    if (!c || !isVoiceRealignment(request, c.at, this.now())) return null;
    if (this.lastTurnKey !== undefined && this.lastTurnKey !== c.key && !c.offeredAt) return null;
    return c;
  }
  /** Context awaiting the owner's answer after a realignment was offered. */
  pendingAnswer(): VoiceTurnContext | null {
    const c = this.live();
    return c && c.offeredAt ? c : null;
  }
  /** Every non-gesture turn seen by the decision route (digest only). */
  noteTurn(request: string) { this.lastTurnKey = VoiceUnderstandingState.key(request); }
  remember(context: VoiceTurnContext | null, request: string) {
    this.context = context ? { ...context, key: VoiceUnderstandingState.key(request) } : null;
  }
  markOffered(context: VoiceTurnContext) {
    if (this.context && this.context.taskId === context.taskId) this.context.offeredAt = this.now();
    context.offeredAt = this.now();
  }
  snapshot() {
    const c = this.live();
    return { active: Boolean(c), offered: Boolean(c?.offeredAt), gestures: VOICE_REALIGNMENT_PHRASES.version };
  }
}

type Owner = {
  understanding: VoiceUnderstandingState;
  sessionLocale(): string;
  executeVoiceCapability(meta: any, request: string, run: () => Promise<any>): Promise<any>;
};
type Execute = (request: string) => Promise<Record<string, any>>;
type Deps = { capture?: RoundCaptureRunner; now?: () => number; assertCurrent?: () => void };

/** Admission is a projection of the resolver's canonical decision, never a lexical pre-router.
 * Confirmed/payment routes still enter the existing executor and its human boundary.
 */
export function deterministicLiveDecision(result: any): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.success !== true) return false;
  const decision = result?.decision;
  const selected = decision?.selected;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)
    || !selected || typeof selected !== "object" || Array.isArray(selected)) return false;
  return decision?.version === 2 && decision?.type === "EXECUTE"
    && typeof decision?.capability === "string" && decision.capability.length > 0
    && selected?.deterministic === true && selected?.model_required === false;
}

/** Harness answer for a correction gesture: evidence required, no resolver or model call. */
export function realignmentDecision() {
  return {
    success: true, state: "voice_realignment",
    harness: { version: 1, tool_policy: "required", evidence_required: true, allow_model_only: false, confidence: 1, reason: "voice_realignment", shortlist: [] },
    gestures: VOICE_REALIGNMENT_PHRASES.version,
  };
}

function realignmentReceipt(context: VoiceTurnContext, learning: RoundCaptureResult) {
  const text = realignmentSpeech(context);
  return {
    success: true,
    state: "needs_clarification",
    source: "voice_realignment",
    capability: null,
    text,
    realignment: {
      understood: { capability: context.understood.capability, label: context.understood.label, source: context.understood.source },
      alternatives: context.alternatives,
      gestures: VOICE_REALIGNMENT_PHRASES.version,
      learning,
    },
    voice: { version: 1, locale: context.locale, phase: "clarify", verbatim: text },
  };
}

/** /claw-live/decision: a listed gesture in the window short-circuits to an evidence-required turn. */
export async function clawLiveDecision(owner: Owner, request: string, resolve: () => Promise<Record<string, any>>) {
  if (owner.understanding.gestureTarget(request)) return realignmentDecision();
  owner.understanding.noteTurn(request);
  // « La première » after a realignment must reach the capability route, not a free model answer.
  if (realignmentChoice(request, owner.understanding.pendingAnswer())) return { ...realignmentDecision(), state: "voice_realignment_choice" };
  const result = await resolve();
  return {...result, voiceFastPath: {version: 1, execute: deterministicLiveDecision(result)}};
}

/** /claw-live/capability: V1/V3 imposed text on every receipt, V2 realignment + Round Learning. */
export async function clawLiveCapability(owner: Owner, body: any, execute: Execute, deps: Deps = {}) {
  const capture = deps.capture || captureVoiceRound;
  const now = deps.now || (() => Date.now());
  const request = String(body?.request || "");
  const locale = voiceLocale(owner.sessionLocale());
  const state = owner.understanding;
  const admit = (run: () => Promise<any>) => {
    const current = () => { deps.assertCurrent?.(); return run(); };
    return body?.voiceTurn ? owner.executeVoiceCapability(body.voiceTurn, request, current) : current();
  };

  const target = state.gestureTarget(request);
  if (target) {
    return admit(async () => {
      state.markOffered(target);
      const payload = realignmentRoundPayload(target, "requested");
      const learning = payload ? await capture(payload) : { state: "skipped", reason: "no_target_intent" };
      return realignmentReceipt(target, learning);
    });
  }

  const stillCurrent = () => { try { deps.assertCurrent?.(); return true; } catch { return false; } };
  const pending = state.pendingAnswer();
  const choice = realignmentChoice(request, pending);
  return admit(async () => {
    const result = await execute(choice ? choice.label : request);
    const responseLanguage=publicDecision(result?.decision)?.responseLanguage;
    // The existing receipt speaker owns FR/EN copy. For derja the Gemini Live
    // turn itself owns arabizi rendering; never impose a French uiLocale
    // verbatim over a Tunisian request.
    const receiptLocale=responseLanguage==='fr'||responseLanguage==='en'?responseLanguage:locale;
    let learning: RoundCaptureResult | undefined;
    if (pending) {
      const corrected = readVoiceUnderstood(result, receiptLocale);
      const payload = realignmentRoundPayload(pending, "resolved", { capability: corrected?.capability || null, route: corrected?.route || null });
      if (payload) learning = stillCurrent() ? await capture(payload) : {state:"skipped",reason:"owner_admission_expired"};
    }
    if (stillCurrent()) state.remember(voiceTurnContext(result, request, { locale:receiptLocale, now: now(), scope: String(body?.voiceTurn?.sessionEpoch || "") }), request);
    const speech=responseLanguage==='tn'?{}:voiceReceiptProjection(result, receiptLocale);
    return { ...result, ...speech, ...(learning ? { realignment_learning: learning } : {}), ...(choice ? { realignment_choice: choice.capability } : {}) };
  });
}

