/** Shared bounded reconnect policy for Companion WebSocket transports. */
export function reconnectDelay(attempt: number) {
  if (attempt <= 0) return 0;
  if (attempt === 1) return 750;
  if (attempt === 2) return 2000;
  return Math.min(60_000, 3000 * 2 ** Math.min(5, attempt - 3));
}
