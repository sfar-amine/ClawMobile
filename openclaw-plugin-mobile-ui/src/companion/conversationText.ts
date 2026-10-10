/** Remove one official Companion transport label, optionally after the Gateway timestamp. */
export function stripConversationTransport(text: string): string {
  const label = /^\[companion-session:[A-Za-z0-9_-]{1,80}\]\r?\n/;
  // A leading label is already the transport envelope: never strip a second label-shaped user line.
  if (label.test(text)) return text.replace(label, "").trim();
  const afterTimestamp = text.replace(/^\[[^\]\n]+\]\s*/, "");
  return afterTimestamp.replace(label, "").trim();
}
