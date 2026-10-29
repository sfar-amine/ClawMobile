// S24 29/10 17:57: after a WhatsApp reconnect the SDK switched the owner run to its fallback model and
// sent Amine « ↪️ Model Fallback: openai/gpt-5.6-terra (selected openai/gpt-5.6-sol; unknown) ».
// These SDK runtime notices (agent-runner buildFallbackNotice / buildFallbackClearedNotice /
// buildProviderPolicyRetryNotice) describe internals, not the request: they stay in the logs only.
const NOTICE = /^\u21AA\uFE0F?\s*(?:Model Fallback(?: cleared)?: |Retried on )\S/u;

/** Text left once the SDK runtime notice lines are removed; null when nothing else remains. */
export function withoutRuntimeNotices(text: string): string | null {
  const lines = text.split("\n");
  const kept = lines.filter(line => !NOTICE.test(line.trim()));
  if (kept.length === lines.length) return text;
  const rest = kept.join("\n").trim();
  return rest ? rest : null;
}

/** message_sending hook: cancel a notice-only message, strip a notice line from a mixed one. */
export function runtimeNoticeSendingHook(event: any) {
  const content = event?.content;
  if (typeof content !== "string" || !content.includes("\u21AA")) return undefined;
  const rest = withoutRuntimeNotices(content);
  if (rest === content) return undefined;
  return rest === null ? { cancel: true } : { content: rest };
}
