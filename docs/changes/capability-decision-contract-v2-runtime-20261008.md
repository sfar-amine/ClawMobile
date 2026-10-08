# Capability Decision Contract V2 runtime — 2026-10-08

The private Companion runtime now transports Skill Intelligence DecisionEnvelope V2 end to end.

## Runtime changes
- `model-fast-path.py` resolves once, returns the DecisionEnvelope on check, validates prepared decisions and executes them without a second semantic resolve.
- Companion reserves the normal stable `clientRunId` together with the decision. Exact duplicates reuse the existing decision/run.
- `CLARIFY` state is stored on the existing run with bounded expiry; a related answer is resolved only against the offered choices and the child run links back to its parent clarification run.
- A clearly unrelated answer abandons the pending clarification and is treated as a new request.
- FAST execution consumes the decision directly.
- DURABLE execution carries the decision in the existing Continuum/Remote Bridge params hash and effect fence.
- Remote Bridge projects mutation risk from a DecisionEnvelope when available before dispatch.
- `capabilityBridge` supports `execute-decision` and non-effect `validate-decision`.
- External MCP `claw_execute` accepts an optional decision; supplied decisions are validated before Continuum admission. Direct execute resolves once and carries the resulting decision automatically.
- The edge MCP schema exposes the optional `decision` field only on `claw_execute`.

## Compatibility
During rollout the helper still understands an old resolution that lacks a V2 decision. Once the canonical UI contract is active, all updated Samantha/MCP paths use DecisionEnvelope V2. This compatibility branch does not create a second router and may be removed after the rollout floor is established.

## Safety/effect integrity
No decision contains payment secrets, OTP, card data or biometric material. Effectful capability-revision changes fail closed to revalidation. Payment Core, owner biometric, issuer authentication, idempotence, readback and Continuum fencing remain the effect authorities.

## Verification
Unit and integration coverage exercises prepared decision execution without resolver re-entry, persistent clarification parent/child continuity, Capability Bridge transport, Continuum read/write fencing, Payment Core, Companion MCP and edge MCP schema/forwarding. No financial effect is exercised by these tests.

## Published UI runtime root
`model-fast-path.py` now honors the existing `CLAW_UI_PLAYBOOKS_ROOT` deployment variable, matching `claw-capability.py` and the MCP bridge. This allows Tier-0 to consume an immutable checkout of the published UI commit without overwriting an engineering checkout that has concurrent uncommitted work. The default remains `~/.openclaw/workspace/ui-playbooks`; no new source of truth or store is introduced.
