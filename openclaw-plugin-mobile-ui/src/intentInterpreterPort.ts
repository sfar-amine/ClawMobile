// Single warm interpretation port (Chantier 1, doc 71). Every surface reaches the same
// interpreter; the Gateway owns provider auth (Gemini free profile, Luna OAuth), so no
// credential is copied and no process or agent session is started per turn.
//
// Gemini decides first. Luna runs only after a technical failure of Gemini: timeout,
// provider/runtime failure, rejected or unparsable output. An authorization or policy
// refusal is never a technical failure and never reaches Luna (decision 3173).

import {brainOnlyEnabled} from "./brainOnly";
import {requireNativePulseInterpretation} from './capabilityAgentGuard';
export const INTERPRETER_PRIMARY = "google/gemini-3.5-flash-lite@google:claw-gemini-free";
export const INTERPRETER_FALLBACK = "openai/gpt-5.6-luna";
export const INTERPRETER_MODELS = Object.freeze([INTERPRETER_PRIMARY, INTERPRETER_FALLBACK]);
export const INTERPRET_METHOD = "samantha.intent.interpret";
// Same credential owner, separate closed engineering contract. Selection and the
// Sol -> Luna -> Gemini free fallback belong to the existing Python governor, never this port.
// Gemini is last so an exhausted OpenAI subscription quota (recurring, decision 25/10) never
// leaves the immune admission without a decider.
export const IMMUNE_PURPOSE = "samantha.engineering.immune";
export const NATIVE_PULSE_PURPOSE = "samantha.native-pulse.interpret";
export const IMMUNE_MODELS = Object.freeze(["openai/gpt-5.6-sol", INTERPRETER_FALLBACK, INTERPRETER_PRIMARY]);

// Codes thrown by OpenClaw's api.runtime.llm.complete (2026.9.6).
const TECHNICAL_CODES = new Set([
  "LLM_COMPLETION_TIMEOUT",
  "LLM_COMPLETION_FAILED",
  "LLM_RUNTIME_UNAVAILABLE",
  "LLM_COMPLETION_OUTPUT_REJECTED",
]);
// OpenClaw's own set of completed stop reasons (runtime-llm finalizePluginLlmCompletion). A provider
// error (S24 25/10: gpt-5.6-sol "429 usage_limit_reached") resolves with empty text and another stop
// reason; it is a provider failure, not an unparsable decision.
const COMPLETED_STOPS = new Set(["stop", "length", "toolUse"]);
const LIMITS = Object.freeze({
  systemChars: 64_000,
  // The playbooks owner bounds the whole interpretation prompt to 80 000 chars / 96 000 bytes.
  userChars: 96_000,
  outputChars: 8_000,
  primaryTimeoutMs: { min: 300, max: 10_000, default: 2_500 },
  totalTimeoutMs: { min: 500, max: 30_000, default: 9_000 },
});

export type InterpretRequest = {
  systemPrompt: string;
  message: string;
  responseSchema?: Record<string, unknown>;
  primaryTimeoutMs?: number;
  totalTimeoutMs?: number;
  purpose?: string;
  /** One governed model only: the caller's model governor owns selection and fallback. */
  model?: string;
};

export type InterpretAttempt = {
  model: string;
  outcome: "ok" | "technical" | "refused" | "aborted";
  code?: string;
  ms: number;
};

export type InterpretResult =
  | { ok: true; decision: Record<string, unknown>; provider: string; model: string;
      responseModel?: string; usage?: Record<string, unknown>; fallbackReason?: string;
      attempts: InterpretAttempt[]; totalMs: number }
  | { ok: false; code: string; attempts: InterpretAttempt[]; totalMs: number };

type LlmComplete = (params: Record<string, unknown>) => Promise<any>;

function bounded(value: unknown, limit: { min: number; max: number; default: number }) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : limit.default;
  return Math.min(limit.max, Math.max(limit.min, Math.floor(n)));
}

/** One JSON object, optionally inside a single json code fence. Its contract
 *  (intent-interpretation.v1) is validated by the playbooks owner, not here. */
export function parseDecision(text: unknown, maxChars: number = LIMITS.outputChars): Record<string, unknown> | null {
  if (maxChars > 64_000 || typeof text !== "string" || !text.trim() || text.length > maxChars) return null;
  let body = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(body);
  if (fence) body = fence[1].trim();
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function validateRequest(raw: unknown): InterpretRequest | null {
  const r = raw as any;
  if (!r || typeof r !== "object") return null;
  if (typeof r.systemPrompt !== "string" || !r.systemPrompt.trim() || r.systemPrompt.length > LIMITS.systemChars) return null;
  if (typeof r.message !== "string" || !r.message.trim() || r.message.length > LIMITS.userChars) return null;
  if (r.responseSchema !== undefined && (typeof r.responseSchema !== "object" || r.responseSchema === null)) return null;
  const immune = r.purpose === IMMUNE_PURPOSE;
  if (immune ? !IMMUNE_MODELS.includes(r.model) : (r.model !== undefined && !INTERPRETER_MODELS.includes(r.model))) return null;
  return {
    systemPrompt: r.systemPrompt,
    message: r.message,
    responseSchema: r.responseSchema,
    primaryTimeoutMs: bounded(r.primaryTimeoutMs, LIMITS.primaryTimeoutMs),
    totalTimeoutMs: bounded(r.totalTimeoutMs, immune ? { min: 500, max: 90_000, default: 60_000 } : LIMITS.totalTimeoutMs),
    purpose: typeof r.purpose === "string" ? r.purpose.slice(0, 80) : undefined,
    model: r.model,
  };
}

async function attempt(complete: LlmComplete, model: string, req: InterpretRequest, timeoutMs: number,
    outer: AbortSignal | undefined, now: () => number) {
  const started = now();
  const immune = req.purpose === IMMUNE_PURPOSE;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await complete({
      model,
      systemPrompt: req.systemPrompt,
      messages: [{ role: "user", content: req.message }],
      ...(req.responseSchema ? { responseFormat: { type: "json_schema", json_schema: { name: "decision", schema: req.responseSchema, strict: true } } } : {}),
      // OpenAI models run on the subscription OAuth only; Gemini stays pinned to its free profile.
      ...(model !== INTERPRETER_PRIMARY && (immune || model === INTERPRETER_FALLBACK) ? { requiredAuthMode: "oauth" } : {}),
      // Gemini Flash Lite answers fastest without thinking; Luna keeps a minimal effort.
      reasoning: model === INTERPRETER_PRIMARY ? "off" : "minimal",
      temperature: 0,
      maxTokens: immune ? 16_384 : 512,
      purpose: req.purpose ?? "samantha.intent.interpret",
      signal: controller.signal,
    });
    const ms = now() - started;
    const empty = typeof result?.text !== "string" || !result.text.trim();
    if (empty && !COMPLETED_STOPS.has(String(result?.stopReason ?? "stop"))) {
      return { attempt: { model, outcome: "technical", code: "LLM_COMPLETION_FAILED", ms } as InterpretAttempt };
    }
    const decision = parseDecision(result?.text, immune ? 64_000 : LIMITS.outputChars);
    if (!decision) return { attempt: { model, outcome: "technical", code: "INVALID_DECISION_OUTPUT", ms } as InterpretAttempt };
    return { attempt: { model, outcome: "ok", ms } as InterpretAttempt, result, decision };
  } catch (error: any) {
    const ms = now() - started;
    if (outer?.aborted) return { attempt: { model, outcome: "aborted", code: "LLM_COMPLETION_ABORTED", ms } as InterpretAttempt };
    const code = controller.signal.aborted ? "LLM_COMPLETION_TIMEOUT" : String(error?.code || "LLM_COMPLETION_FAILED");
    const outcome = TECHNICAL_CODES.has(code) ? "technical" : code === "LLM_COMPLETION_ABORTED" ? "aborted" : "refused";
    return { attempt: { model, outcome, code, ms } as InterpretAttempt };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/** Gemini, then Luna on a technical failure only, inside one total deadline;
 *  or exactly the one model a caller's governor selected. */
export async function interpret(complete: LlmComplete, req: InterpretRequest,
    opts: { signal?: AbortSignal; now?: () => number } = {}): Promise<InterpretResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const total = req.totalTimeoutMs ?? LIMITS.totalTimeoutMs.default;
  const attempts: InterpretAttempt[] = [];
  if (req.purpose === IMMUNE_PURPOSE && !IMMUNE_MODELS.includes(req.model!)) {
    return { ok: false, code: "INVALID_REQUEST", attempts, totalMs: now() - started };
  }
  let fallbackReason: string | undefined;
  const models = req.model ? [req.model] : INTERPRETER_MODELS;
  for (const model of models) {
    const left = total - (now() - started);
    if (left < LIMITS.primaryTimeoutMs.min) break;
    const budget = model === INTERPRETER_PRIMARY && !req.model ? Math.min(req.primaryTimeoutMs ?? LIMITS.primaryTimeoutMs.default, left) : left;
    const out = await attempt(complete, model, req, budget, opts.signal, now);
    attempts.push(out.attempt);
    if (out.attempt.outcome === "ok") {
      return { ok: true, decision: out.decision!, provider: String(out.result?.provider ?? ""),
        model: String(out.result?.model ?? ""), responseModel: out.result?.responseModel,
        usage: out.result?.usage, fallbackReason, attempts, totalMs: now() - started };
    }
    if (out.attempt.outcome !== "technical") {
      return { ok: false, code: out.attempt.code ?? "LLM_COMPLETION_FAILED", attempts, totalMs: now() - started };
    }
    fallbackReason = out.attempt.code;
  }
  return { ok: false, code: req.model ? (attempts.at(-1)?.code ?? "INTERPRETER_UNAVAILABLE") : "INTERPRETER_UNAVAILABLE",
    attempts, totalMs: now() - started };
}

/** Gateway method body: validated request in, structured decision or stable code out. */
export function createInterpretHandler(getComplete: () => LlmComplete | undefined) {
  return async ({ params, respond, signal }: any) => {
    const req = validateRequest(params);
    if (!req) return respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid interpretation request" });
    // The shared engineering completion owner survives the C1 interpreter's
    // retirement. No owner request may invoke its old semantic purpose.
    if(params?.purpose===NATIVE_PULSE_PURPOSE){
      if(brainOnlyEnabled())return respond(false,undefined,{code:'INVALID_REQUEST',message:'dedicated intent interpreter retired'});
      // Native professional DATA01 currently admits this one included profile.
      // The existing governor owns any future extension; a purpose cannot mint a model fallback.
      if(params?.model!==INTERPRETER_PRIMARY)return respond(false,undefined,{code:'INVALID_REQUEST',message:'native Pulse model not admitted'});
      try{await requireNativePulseInterpretation(params);}
      catch{return respond(false,undefined,{code:'INVALID_REQUEST',message:'native Pulse admission required'});}
    }
    if (brainOnlyEnabled() && params?.purpose !== IMMUNE_PURPOSE)
      return respond(false, undefined, {code: "INVALID_REQUEST", message: "dedicated intent interpreter retired"});
    const complete = getComplete();
    if (!complete) return respond(false, undefined, { code: "UNAVAILABLE", message: "llm runtime unavailable" });
    const result = await interpret(complete, req, { signal });
    respond(true, result);
  };
}
