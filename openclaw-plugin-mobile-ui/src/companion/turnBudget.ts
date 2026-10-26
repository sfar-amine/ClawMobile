/** One delivery budget; expiration changes delivery, never replays or cancels a business effect. */
export const TURN_BUDGET_MS = 30_000;

export function remainingTurnBudgetMs(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt) return 0;
  return Math.max(0, TURN_BUDGET_MS - Math.ceil(now - startedAt));
}

export type TurnSurface = "app" | "whatsapp" | "voice";
export type TurnRoute = "tool" | "question" | "answer" | "reflex";
export type TurnMeasurement = {
  version: 1; surface: TurnSurface; route: TurnRoute; model?: string;
  firstSignMs: number | null; decisionMs: number | null; toolMs: number | null;
  usefulMs: number | null; totalMs: number | null;
};
const durations = ["firstSignMs", "decisionMs", "toolMs", "usefulMs", "totalMs"] as const;
const keys = new Set(["version", "surface", "route", "model", ...durations]);
const duration = (v: unknown): v is number | null => v === null ||
  (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 600_000);

/** Closed metadata only. Missing observations remain null, never synthetic zero-latency successes. */
export function validateTurnMeasurement(raw: unknown): TurnMeasurement | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some(k => !keys.has(k)) || v.version !== 1 ||
      !["app", "whatsapp", "voice"].includes(String(v.surface)) ||
      !["tool", "question", "answer", "reflex"].includes(String(v.route)) ||
      !durations.every(k => duration(v[k])) ||
      (v.model !== undefined && (typeof v.model !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(v.model)))) return undefined;
  const n = (k: typeof durations[number]) => v[k] as number | null;
  if (n("firstSignMs") !== null && n("usefulMs") !== null && n("firstSignMs")! > n("usefulMs")! ||
      n("usefulMs") !== null && n("totalMs") !== null && n("usefulMs")! > n("totalMs")!) return undefined;
  return {version: 1, surface: v.surface as TurnSurface, route: v.route as TurnRoute,
    ...(v.model === undefined ? {} : {model: v.model as string}),
    firstSignMs: n("firstSignMs"), decisionMs: n("decisionMs"), toolMs: n("toolMs"),
    usefulMs: n("usefulMs"), totalMs: n("totalMs")};
}

/** Caller is the existing run owner after its terminal measurement has been persisted once. */
export function turnMeasurementLogLine(value: TurnMeasurement): string {
  const v = validateTurnMeasurement(value);
  if (!v) throw new Error("invalid_turn_measurement");
  const show = (n: number | null) => n === null ? "-" : String(n);
  return `[turn] surface=${v.surface} route=${v.route} model=${v.model || "-"}` +
    ` first_sign_ms=${show(v.firstSignMs)} decision_ms=${show(v.decisionMs)}` +
    ` tool_ms=${show(v.toolMs)} useful_ms=${show(v.usefulMs)} total_ms=${show(v.totalMs)}`;
}

export function summarizeTurnMeasurements(values: unknown[]) {
  const rows = values.flatMap(v => {const row = validateTurnMeasurement(v); return row ? [row] : [];});
  return (["app", "whatsapp", "voice"] as TurnSurface[]).map(surface => {
    const group = rows.filter(v => v.surface === surface);
    const useful = group.flatMap(v => v.usefulMs === null ? [] : [v.usefulMs]).sort((a, b) => a - b);
    const signs = group.flatMap(v => v.firstSignMs === null ? [] : [v.firstSignMs]);
    const n = useful.length;
    return {surface, turns: group.length, usefulSamples: n, firstSignSamples: signs.length,
      medianUsefulMs: n ? (useful[Math.floor((n - 1) / 2)] + useful[Math.floor(n / 2)]) / 2 : null,
      p95UsefulMs: n ? useful[Math.ceil(n * .95) - 1] : null,
      firstSignUnder1s: signs.filter(v => v < 1000).length};
  });
}
