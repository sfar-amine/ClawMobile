/** Conservative evidence from the owner Gateway, independent of its SQLite layout. */
export const RUN_INACTIVITY_MS = 10 * 60 * 1000;
export type InactivityReceipt = {
  version: 1; action: "correct_run_expiration"; runId: string;
  from: "expired"; to: "running" | "done"; at: number; evidenceAt: number;
};

export function protectedRun(run: {decision?: Record<string, unknown>}, payments: any[], confirmations: any[]): boolean {
  // Caller origin IDs are not proof of the absence of a canonical link. Pending
  // or unrecognised guards therefore protect the entire candidate set.
  if (payments.some(p => !["confirmed", "demo_confirmed", "failed", "cancelled", "expired", "blocked"].includes(p?.state))) return true;
  if (confirmations.some(c => !["consumed", "cancelled", "expired"].includes(c?.state))) return true;
  const guarded = (value: any): boolean => {
    if (typeof value === "string") return /payment\.|bank|biometr|confirmation|awaiting_owner/i.test(value);
    if (!value || typeof value !== "object") return false;
    if (value.confirmationRequired === true || value.confirmation_required === true ||
        value.humanBoundary || value.human_boundary) return true;
    return Object.values(value).some(guarded);
  };
  return guarded(run.decision);
}

export function ownerTurnEvidence(messages: any[], prompt: string, now: number):
  {messages: any[]; startedAt: number; lastAt: number; outstandingTool: boolean} | undefined {
  if (!Array.isArray(messages) || messages.length > 200) return undefined;
  const text = (content: any) => typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(c => c?.type === "text").map(c => c.text).join("\n") : "";
  const matches = messages.map((m, i) => m?.role === "user" &&
    text(m.content).replace(/^\[[^\]\n]+\]\s*/, "") === prompt ? i : -1).filter(i => i >= 0);
  if (matches.length !== 1) return undefined;
  const start = matches[0];
  let end = messages.findIndex((m, i) => i > start && m?.role === "user");
  if (end < 0) end = messages.length;
  const turn = messages.slice(start, end), tools = new Set<string>();
  let lastAt = 0, startedAt = 0;
  for (const message of turn) {
    const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp);
    // Undated, future or unknown events cannot prove an inactive trajectory.
    if (!Number.isFinite(at) || at <= 0 || at > now || !["user", "assistant", "toolResult"].includes(message.role)) return undefined;
    if (!startedAt) startedAt = at;
    lastAt = Math.max(lastAt, at);
    for (const item of Array.isArray(message.content) ? message.content : []) {
      if (item?.type === "toolCall") {
        if (typeof item.id !== "string" || !item.id) return undefined;
        tools.add(item.id);
      }
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !tools.has(message.toolCallId)) return undefined;
      tools.delete(message.toolCallId);
    }
  }
  return {messages: turn, startedAt, lastAt, outstandingTool: tools.size > 0};
}
