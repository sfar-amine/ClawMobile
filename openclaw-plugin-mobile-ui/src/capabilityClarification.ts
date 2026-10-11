import crypto from "node:crypto";
import { readReceiptPresentation, publicReceiptMetadata } from "./companion/receiptPresentation";
import type { FastPathResult, RunnerOptions } from "./modelFastPath";

/** 38 E3 — one CLARIFY contract for the surfaces that are not the app (WhatsApp, voice relay, Gemini Live).
 *
 * Every turn is first checked by the canonical fast path with the user's ORIGINAL text
 * (`model-fast-path.py --check`, Capability Graph decision v2). A CLARIFY question is kept
 * pending for 10 minutes, and the next answer goes through `--resolve-clarification`
 * (never a concatenation of the original request and the answer). No route is chosen here.
 *
 * The app keeps its durable clarification in the Companion run registry (`intent.ts`). These
 * surfaces keep a bounded in-process copy: the run registry is owned by the Companion process,
 * and the gateway (`inbound_claim`) must not write it concurrently. Losing it on restart only
 * abandons the question (fail closed).
 */
export type ClarificationRunner = (message: string, options?: RunnerOptions) => Promise<FastPathResult>;

type Pending = { originalText: string; decision: Record<string, unknown>; surface: string; at: number };

export type SurfaceTurn =
  | { state: "needs_clarification"; clarificationId: string; question: string; choices: unknown[]; decision?: Record<string, unknown>; presentation?: unknown }
  | { state: "done" | "failed"; text: string; source: "capability"; result?: unknown; decision?: Record<string, unknown>; presentation?: unknown }
  | { state: "continue"; text: string; resolvedFrom?: string; decision?: Record<string, unknown>; presentation?: unknown };

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 64;
const ID_RE = /^clar-[a-f0-9]{24}$/;

export class SurfaceClarifications {
  private pending = new Map<string, Pending>();
  constructor(private runner: ClarificationRunner, private now: () => number = Date.now) {}

  size() { this.cleanup(); return this.pending.size; }

  private cleanup() {
    const now = this.now();
    for (const [key, value] of this.pending) if (now - value.at > TTL_MS) this.pending.delete(key);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
  }

  private remember(id: string, value: Omit<Pending, "at">) {
    this.pending.delete(id);
    this.pending.set(id, { ...value, at: this.now() });
    this.cleanup();
  }

  static newId() { return "clar-" + crypto.randomBytes(12).toString("hex"); }

  /** A stable id for a host conversation key (for example a WhatsApp session key). */
  static idFor(key: string) { return "clar-" + crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 24); }

  /** Keep a CLARIFY decision the caller already obtained from the fast path (no second resolution). */
  hold(id: string, originalText: string, decision: Record<string, unknown>, surface: string) {
    if (!ID_RE.test(id) || !decision || String(decision.type || "") !== "CLARIFY") return false;
    this.remember(id, { originalText: String(originalText || "").trim(), decision, surface });
    return true;
  }

  hasPending(id: string) { this.cleanup(); return this.pending.has(id); }

  /**
   * @param text the user's original text for this turn (transcription, message), never a model reformulation.
   * @param id   the pending clarification id for this conversation, when there is one.
   */
  async turn(text: string, options: { surface: string; id?: string; originId: string; timeoutSeconds?: number; assertCurrent?: () => void }): Promise<SurfaceTurn> {
    options.assertCurrent?.();
    this.cleanup();
    const original = String(text || "").trim();
    const surface = options.surface;
    const id = options.id && ID_RE.test(options.id) ? options.id : undefined;
    const pending = id ? this.pending.get(id) : undefined;
    const common = { surface, caller: "owner" as const, originId: options.originId, timeoutSeconds: options.timeoutSeconds ?? 12 };
    if (id && pending) {
      const clarified = await this.runner(original, {
        ...common, checkOnly: true,
        clarificationDecision: pending.decision, clarificationOriginalText: pending.originalText,
      });
      options.assertCurrent?.();
      if (clarified.status === "clarification") {
        this.remember(id, { ...pending, decision: (clarified.decision as Record<string, unknown>) || pending.decision });
        return {
          state: "needs_clarification", clarificationId: id,
          question: String(clarified.text || (clarified.clarification as any)?.question || "Précise ce que tu veux faire."),
          choices: Array.isArray((clarified.clarification as any)?.choices) ? (clarified.clarification as any).choices : [],
          decision: clarified.decision, ...publicReceiptMetadata(readReceiptPresentation(clarified)),
        };
      }
      this.pending.delete(id);
      if (clarified.status !== "clarification_unrelated") {
        const resolvedText = String((clarified.resolution as any)?.text || pending.originalText).trim();
        if (clarified.status === "known_error") {
          return { state: "failed", source: "capability", text: String(clarified.text || "La clarification Claw n'est plus valide."), decision: clarified.decision, ...publicReceiptMetadata(readReceiptPresentation(clarified)) };
        }
        if (clarified.status === "eligible" && clarified.decision) {
          const executed = await this.executePrepared(resolvedText, clarified.decision as Record<string, unknown>, common, options.assertCurrent);
          if (executed) return executed;
        }
        // miss/assist: the surface continues with the RESOLVED text (resolution.text), no concatenation.
        return { state: "continue", text: resolvedText, resolvedFrom: pending.originalText, decision: clarified.decision, ...publicReceiptMetadata(readReceiptPresentation(clarified)) };
      }
      // Unrelated answer: a new request, handled below from its own original text.
    }
    const check = await this.runner(original, { ...common, checkOnly: true });
    options.assertCurrent?.();
    if (check.status === "clarification" && check.decision) {
      const newId = id || SurfaceClarifications.newId();
      this.remember(newId, { originalText: original, decision: check.decision as Record<string, unknown>, surface });
      return {
        state: "needs_clarification", clarificationId: newId,
        question: String(check.text || (check.clarification as any)?.question || "Précise ce que tu veux faire."),
        choices: Array.isArray((check.clarification as any)?.choices) ? (check.clarification as any).choices : [],
        decision: check.decision, ...publicReceiptMetadata(readReceiptPresentation(check)),
      };
    }
    if (check.status === "known_error" && check.text) {
      return { state: "failed", source: "capability", text: String(check.text), decision: check.decision, ...publicReceiptMetadata(readReceiptPresentation(check)) };
    }
    // A transaction (or any decision needing the owner confirmation) runs the prepared decision through
    // the same fast path as the app: owner confirmation card / handoff, never the agent.
    if (check.status === "eligible" && check.decision && !isPlainRead(check.decision as Record<string, unknown>)) {
      const executed = await this.executePrepared(original, check.decision as Record<string, unknown>, common, options.assertCurrent);
      if (executed) return executed;
    }
    // Plain reads keep the surface's existing executor and renderer, on the original text.
    return { state: "continue", text: original, decision: check.decision, ...publicReceiptMetadata(readReceiptPresentation(check)) };
  }

  private async executePrepared(text: string, decision: Record<string, unknown>, common: RunnerOptions, assertCurrent?: () => void): Promise<SurfaceTurn | null> {
    assertCurrent?.();
    const executed = await this.runner(text, {
      ...common, checkOnly: false, timeoutSeconds: Math.max(Number(common.timeoutSeconds || 12), 75), preparedDecision: decision,
    });
    if (executed.status === "hit") return { state: "done", source: "capability", text: String(executed.text || "Claw a terminé la capacité."), result: (executed as any).result, decision: executed.decision, ...publicReceiptMetadata(readReceiptPresentation(executed)) };
    if (executed.status === "known_error") return { state: "failed", source: "capability", text: String(executed.text || "Claw n'a pas pu terminer la capacité."), decision: executed.decision, ...publicReceiptMetadata(readReceiptPresentation(executed)) };
    return null;
  }
}

function isPlainRead(decision: Record<string, unknown>): boolean {
  return String(decision.risk || "read") === "read" && decision.confirmationRequired !== true;
}
