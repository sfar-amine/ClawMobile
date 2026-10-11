/** 38 E3 — before_tool_call boundary for `clawmobile_capability`.
 *
 * The hook never resolves nor decides a route (no second router). It only:
 *  - copies the model arguments as independent scalars and refuses malformed ones;
 *  - replaces `caller` by the host turn identity (`requester.senderIsOwner`), never the model's.
 * The risk/operator decision is atomic inside the tool: `claw-capability.py agent-execute`
 * resolves once with the canonical Capability Graph, applies the E3 policy and executes exactly
 * that decision with the graph's existing read-only policy (`capability_first_required` otherwise).
 */
export type AgentCapabilityHookContext = { requester?: { senderIsOwner?: unknown } };
export type AgentCapabilityHookEvent = { toolName?: unknown; params?: unknown };
export type AgentCapabilityHookResult = { params?: Record<string, unknown>; block?: boolean; blockReason?: string };

export const AGENT_CAPABILITY_REFUSAL = "capability_first_required";

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

export function agentCapabilityHook(
  event: AgentCapabilityHookEvent,
  context: AgentCapabilityHookContext,
): AgentCapabilityHookResult | undefined {
  const refused = (): AgentCapabilityHookResult => ({ block: true, blockReason: AGENT_CAPABILITY_REFUSAL });
  try {
    const toolName = ownData(event, "toolName");
    if (typeof toolName !== "string") return refused();
    if (toolName !== "clawmobile_capability") return undefined;
    const params = scalarSnapshot(ownData(event, "params"));
    if (!params || typeof params.request !== "string" || !params.request.trim() || params.request.length > 12000) return refused();
    // The model never supplies authority: drop its caller, then use the host turn identity when present.
    const { caller: _modelCaller, ...rest } = params;
    const owner = ownData(ownData(context, "requester"), "senderIsOwner");
    const next: Record<string, unknown> = { ...rest };
    if (typeof owner === "boolean") next.caller = owner ? "owner" : "other";
    return { params: next };
  } catch {
    // Descriptor/prototype inspection of a malformed object must also fail closed.
    return refused();
  }
}
