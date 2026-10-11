import { open } from "fs/promises";
import { constants } from "fs";
import { createHash } from "crypto";
import { comprehensionRunFacts, type ComprehensionRunFact } from "./runs";

const labels: Record<string, {fr: string; en: string}> = {
  "control_plane.nightly_acceptance": {fr: "Recette nocturne", en: "Nightly acceptance"},
  "control_plane.maintenance": {fr: "Maintenance du système", en: "System maintenance"},
  "immune.root_guardian": {fr: "Supervision principale", en: "Root guardian"},
  "immune.health_manager": {fr: "Gestionnaire de santé", en: "Health manager"},
  "immune.incident_orchestrator": {fr: "Gestionnaire d’incidents", en: "Incident orchestrator"},
};
const states: Record<string, string> = {ready: "healthy", ok: "healthy", down: "failed", stale: "degraded", unverified: "unknown", human_required: "waiting"};
const allowed = new Set(["healthy", "attention", "degraded", "running", "waiting", "blocked", "failed", "recovered", "resolved", "disabled", "unknown"]);
function status(value: unknown) {
  const raw = typeof value === "string" ? value.toLowerCase() : "unknown";
  return states[raw] || (allowed.has(raw) ? raw : "unknown");
}
const descriptions: Record<string, string> = {
  nightly_acceptance_attention: "La recette nocturne signale une dérive de latence.",
  nightly_acceptance_failed: "La recette nocturne a échoué.",
  nightly_acceptance_stale: "La preuve de recette nocturne est ancienne.",
  nightly_acceptance_unavailable: "Aucune preuve de recette nocturne disponible.",
  nightly_acceptance_incomplete: "La recette nocturne est incomplète.",
  daily_log_audit: "Audit du journal quotidien incomplet.",
  scheduler_health: "Planificateur à surveiller.",
};
/** Closed list only; the Health Manager may join several reasons with commas (e.g. "scheduler_health,daily_log_audit"). */
function description(value: unknown): string {
  if (typeof value !== "string") return "Diagnostic du composant indisponible.";
  const known = value.split(",").map(part => part.trim())
    .filter(part => Object.prototype.hasOwnProperty.call(descriptions, part)).map(part => descriptions[part]);
  return known.length ? [...new Set(known)].join(" ") : "Diagnostic du composant indisponible.";
}
function stamp(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 253402300799
    ? new Date(value * 1000).toISOString() : null;
}

/** Additive projection of the existing Health Manager verdict; never probes or repairs. */
export function projectHealthComponents(data: any, verdict: any, now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const components = Array.isArray(data.components) ? data.components.map((row: any) => ({...row})) : [];
  const generated = verdict?.generated_at;
  const fresh = typeof generated === "number" && Number.isFinite(generated) && now >= generated * 1000 && now - generated * 1000 <= 300000;
  const capabilities = verdict?.capabilities;
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
    for (const id of Object.keys(capabilities).sort()) {
      const row = capabilities[id];
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || !row || typeof row !== "object" || Array.isArray(row)) continue;
      const existing = components.findIndex((item: any) => item.id === id);
      const observed = status(row.state);
      if (observed === "healthy" && existing < 0) continue;
      const label = labels[id] || {fr: id, en: id};
      const item = {...(existing >= 0 ? components[existing] : {}), id, name: existing >= 0 ? components[existing].name : label.fr, label,
        status: fresh ? observed : "unknown", checkedAt: stamp(row.checked_at) ?? (existing >= 0 ? components[existing].checkedAt : null),
        ...(observed !== "healthy" ? {description: description(row.reason)} : {})};
      if (existing >= 0) components[existing] = item; else components.push(item);
    }
  }
  return {...data, components, canonicalVerdict: {fresh, status: fresh ? status(verdict.overall) : "unknown",
    checkedAt: stamp(generated)}};
}

const WINDOWS: Array<[string, number]> = [["24h", 86_400_000], ["7d", 7 * 86_400_000]];
const rate = (part: number, total: number) => total > 0 ? Math.round(part / total * 1000) / 1000 : null;

/**
 * 38 M1 — compréhension, depuis les reçus de runs existants (registre `runs.json`, décisions v2) : taux de CLARIFY,
 * de « Ce n'est pas ça » et de résolutions directes par une association apprise, sur 24 h et 7 jours. Aucun texte.
 * Attention (fichier 38 § 3.4) : une transaction corrigée sur 7 jours, ou plus de 30 % de questions sur 7 jours.
 */
export function projectComprehension(input: {facts: ComprehensionRunFact[]; retainedCap: number} | null, now = Date.now()) {
  if (!input || !Array.isArray(input.facts)) {
    return {status: "unknown", source: "runs", windows: null, reasons: ["comprehension_source_unavailable"]};
  }
  const facts = input.facts.filter(f => Number.isFinite(f.acceptedAt) && f.acceptedAt > 0 && f.acceptedAt <= now + 60_000);
  const oldest = facts.reduce<number | null>((min, f) => min === null || f.acceptedAt < min ? f.acceptedAt : min, null);
  const windows: Record<string, any> = {};
  for (const [id, span] of WINDOWS) {
    const start = now - span;
    const inWindow = facts.filter(f => f.acceptedAt >= start);
    const decided = inWindow.filter(f => typeof f.decisionType === "string");
    const clarify = decided.filter(f => f.decisionType === "CLARIFY").length;
    const notThis = decided.filter(f => typeof f.notThisAt === "number").length;
    const learned = decided.filter(f => f.decisionType === "EXECUTE" && f.learned).length;
    windows[id] = {
      runs: inWindow.length, decidedRuns: decided.length, agentRuns: inWindow.filter(f => f.agent).length,
      clarify, notThis, learnedDirect: learned, clarificationAnswers: decided.filter(f => f.clarificationAnswer).length,
      clarifyRate: rate(clarify, decided.length), notThisRate: rate(notThis, decided.length), learnedDirectRate: rate(learned, decided.length),
      // Le registre garde au plus `retainedCap` runs : une fenêtre plus ancienne que le plus vieux run retenu est partielle.
      complete: facts.length < input.retainedCap || (oldest !== null && oldest <= start),
    };
  }
  const week = windows["7d"];
  const reasons: string[] = [];
  if (facts.some(f => f.acceptedAt >= now - 7 * 86_400_000 && typeof f.notThisAt === "number" && f.decisionRisk === "transaction")) reasons.push("transaction_corrected");
  if (week.clarifyRate !== null && week.clarifyRate > 0.3) reasons.push("clarify_rate_above_30pct");
  return {
    status: week.decidedRuns === 0 ? "unknown" : reasons.length ? "attention" : "healthy",
    label: {fr: "Compréhension", en: "Understanding"},
    source: "runs", retainedRuns: facts.length, oldestRunAt: oldest === null ? null : new Date(oldest).toISOString(),
    windows, reasons,
    descriptions: reasons.map(r => r === "transaction_corrected"
      ? {fr: "Une transaction a été corrigée par « Ce n’est pas ça » cette semaine.", en: "A transaction was corrected with “That’s not it” this week."}
      : {fr: "Plus de 30 % des demandes de la semaine ont posé une question.", en: "More than 30% of this week’s requests needed a question."}),
  };
}

export async function completeHealthSection(result: any, source: string, now = Date.now()) {
  const section = result?.sections?.health;
  if (!section?.data) return result;
  let verdict: any = null;
  try {
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (stat.isFile() && stat.size <= 1024 * 1024) verdict = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
  } catch { /* Missing/invalid authority does not invent a health result. */ }
  section.data = projectHealthComponents(section.data, verdict, now);
  if (section.data && typeof section.data === "object" && !Array.isArray(section.data)) {
    section.data = {...section.data, comprehension: projectComprehension(await comprehensionRunFacts().catch(() => null), now)};
  }
  section.dataRevision = createHash("sha256").update(JSON.stringify(["health-components-c12-v1", section.dataRevision, section.data])).digest("hex");
  return result;
}
