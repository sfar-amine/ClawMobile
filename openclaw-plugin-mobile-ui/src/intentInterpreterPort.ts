// Single warm interpretation port (Chantier 1, doc 71). Every surface reaches the same
// interpreter; the Gateway owns provider auth (Gemini free profile, Luna OAuth), so no
// credential is copied and no process or agent session is started per turn.
//
// Gemini decides first. Luna runs only after a technical failure of Gemini: timeout,
// provider/runtime failure, rejected or unparsable output. An authorization or policy
// refusal is never a technical failure and never reaches Luna (decision 3173).

export const INTERPRETER_PRIMARY = "google/gemini-3.5-flash-lite@google:claw-gemini-free";
export const INTERPRETER_FALLBACK = "openai/gpt-5.6-luna";
export const INTERPRETER_MODELS = Object.freeze([INTERPRETER_PRIMARY, INTERPRETER_FALLBACK]);
export const INTERPRET_METHOD = "samantha.intent.interpret";

// Codes thrown by OpenClaw's api.runtime.llm.complete (2026.9.6).
const TECHNICAL_CODES = new Set([
  "LLM_COMPLETION_TIMEOUT",
  "LLM_COMPLETION_FAILED",
  "LLM_RUNTIME_UNAVAILABLE",
  "LLM_COMPLETION_OUTPUT_REJECTED",
]);
const LIMITS = Object.freeze({
  systemChars: 64_000,
  userChars: 32_000,
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
export function parseDecision(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || !text.trim() || text.length > LIMITS.outputChars) return null;
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
  return {
    systemPrompt: r.systemPrompt,
    message: r.message,
    responseSchema: r.responseSchema,
    primaryTimeoutMs: bounded(r.primaryTimeoutMs, LIMITS.primaryTimeoutMs),
    totalTimeoutMs: bounded(r.totalTimeoutMs, LIMITS.totalTimeoutMs),
    purpose: typeof r.purpose === "string" ? r.purpose.slice(0, 80) : undefined,
  };
}

async function attempt(complete: LlmComplete, model: string, req: InterpretRequest, timeoutMs: number,
    outer: AbortSignal | undefined, now: () => number) {
  const started = now();
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
      ...(model === INTERPRETER_FALLBACK ? { requiredAuthMode: "oauth" } : {}),
      // Gemini Flash Lite answers fastest without thinking; Luna keeps a minimal effort.
      reasoning: model === INTERPRETER_PRIMARY ? "off" : "minimal",
      temperature: 0,
      maxTokens: 512,
      purpose: req.purpose ?? "samantha.intent.interpret",
      signal: controller.signal,
    });
    const decision = parseDecision(result?.text);
    const ms = now() - started;
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

/** Gemini, then Luna on a technical failure only, inside one total deadline. */
export async function interpret(complete: LlmComplete, req: InterpretRequest,
    opts: { signal?: AbortSignal; now?: () => number } = {}): Promise<InterpretResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const total = req.totalTimeoutMs ?? LIMITS.totalTimeoutMs.default;
  const attempts: InterpretAttempt[] = [];
  let fallbackReason: string | undefined;
  for (const model of INTERPRETER_MODELS) {
    const left = total - (now() - started);
    if (left < LIMITS.primaryTimeoutMs.min) break;
    const budget = model === INTERPRETER_PRIMARY ? Math.min(req.primaryTimeoutMs ?? LIMITS.primaryTimeoutMs.default, left) : left;
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
  return { ok: false, code: "INTERPRETER_UNAVAILABLE", attempts, totalMs: now() - started };
}

/** Gateway method body: validated request in, structured decision or stable code out. */
export function createInterpretHandler(getComplete: () => LlmComplete | undefined) {
  return async ({ params, respond, signal }: any) => {
    const req = validateRequest(params);
    if (!req) return respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid interpretation request" });
    const complete = getComplete();
    if (!complete) return respond(false, undefined, { code: "UNAVAILABLE", message: "llm runtime unavailable" });
    const result = await interpret(complete, req, { signal });
    respond(true, result);
  };
}
