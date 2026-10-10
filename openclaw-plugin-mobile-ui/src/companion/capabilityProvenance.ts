/** Closed, bounded projection of a canonical capability execution receipt. */
export type CapabilityProvenance = { capability: string; route: string; network_path?: "wifi_off" | "cellular_bind_wifi_on" };
export function capabilityProvenance(value: unknown): CapabilityProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(v);
  if (!identifier(row.capability) || !identifier(row.route)) return undefined;
  return {
    capability: row.capability, route: row.route,
    ...(["wifi_off", "cellular_bind_wifi_on"].includes(String(row.network_path))
      ? { network_path: row.network_path as CapabilityProvenance["network_path"] } : {}),
  };
}
