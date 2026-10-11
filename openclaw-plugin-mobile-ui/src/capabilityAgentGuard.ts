/** Preparation only: not registered until the canonical decision is bound to execution.
 * The evidence argument belongs to the future canonical owner boundary, never event.params.
 * No resolver, dispatcher, fallback or store is added here.
 */
export type AgentCapabilityPolicyEvidence = { risk: unknown; operatorTarget: unknown };
export type AgentCapabilityHookContext = { requester?: { senderIsOwner?: unknown } };
export type AgentCapabilityHookEvent = { toolName?: unknown; params?: unknown };
export type AgentCapabilityHookResult = { params?: Record<string, unknown>; block?: boolean; blockReason?: string };

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value: unknown, name: string): unknown {
  if (!plainRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** JSON tool arguments are flat scalar fields. Never retain mutable nested references. */
function scalarSnapshot(value: unknown): Record<string, unknown> | null {
  if (!plainRecord(value)) return null;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    const field = descriptor.value;
    if (field !== null && field !== undefined && !["string", "boolean", "number"].includes(typeof field)) return null;
    if (typeof field === "number" && !Number.isFinite(field)) return null;
    if (descriptor.enumerable) snapshot[key] = field;
  }
  return snapshot;
}

export function prepareAgentCapabilityGuard(
  event: AgentCapabilityHookEvent,
  context: AgentCapabilityHookContext,
  evidence?: AgentCapabilityPolicyEvidence,
): AgentCapabilityHookResult | undefined {
  const refused = (): AgentCapabilityHookResult => ({ block: true, blockReason: "capability_first_required" });
  try {
    const toolName = ownData(event, "toolName");
    if (typeof toolName !== "string") return refused();
    if (toolName !== "clawmobile_capability") return undefined;
    const params = scalarSnapshot(ownData(event, "params"));
    const owner = ownData(ownData(context, "requester"), "senderIsOwner");
    if (!params || typeof owner !== "boolean" || typeof params.request !== "string" ||
      !params.request.trim() || params.request.length > 12000) return refused();
    // Model arguments and inherited/accessor fields are never policy evidence.
    if (ownData(evidence, "risk") !== "read" || ownData(evidence, "operatorTarget") !== false) return refused();
    return { params: { ...params, caller: owner ? "owner" : "other" } };
  } catch {
    // Descriptor/prototype inspection of a malformed object must also fail closed.
    return refused();
  }
}
