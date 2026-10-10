import { open } from "fs/promises";
import { constants } from "fs";
import { createHash } from "crypto";

const labels: Record<string, {fr: string; en: string}> = {
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
const descriptions: Record<string, string> = {daily_log_audit: "Audit du journal quotidien incomplet."};
function description(value: unknown): string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(descriptions,value)
    ? descriptions[value] : "Diagnostic du composant indisponible.";
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
        status: fresh ? observed : "unknown", checkedAt: stamp(row.checked_at), description: description(row.reason)};
      if (existing >= 0) components[existing] = item; else components.push(item);
    }
  }
  return {...data, components, canonicalVerdict: {fresh, status: fresh ? status(verdict.overall) : "unknown",
    checkedAt: stamp(generated)}};
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
  section.dataRevision = createHash("sha256").update(JSON.stringify(["health-components-c12-v1", section.dataRevision, section.data])).digest("hex");
  return result;
}
