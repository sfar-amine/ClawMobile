# ADR — bind MCP interpretation to an authenticated service

Status: implemented in source; exact-head CI and activation pending.

A client context describes a conversation; its presence does not select a service. The existing MCP tools accept a closed `service_scope` selector (`mcp-service.v1`, `domain_id: pulse`). The existing server client record independently admits `interpretation_services: [pulse]`; absence is empty. A selector alone is never an admission.

The authenticated relay stamps the service on its existing frame. C12 preserves that binding in its existing WeakMap, then in the bounded private IPC header `mcp-host-context.v2`. Public scope and request/context are included in the canonical digest; the private header also binds client, request, profile, peer and a maximum 30-second lifetime. Missing, invalid, copied, mutated, expired or unadmitted scope fails before private owner construction or helper execution. Old tool calls without the new context stay on their existing path. Invalid new input never falls back there.

The paired playbooks owner authenticates all fields of its existing read capability with a process-private HMAC and selects the whole canonical Pulse domain internally. It cannot gain scope by `dataclasses.replace`, public construction or subclassing. Service admission does not establish professional DATA, source consent, provider admission or business execution permission. Those owners remain independent.

No new registry, store, router, executor or daemon is introduced. Direct live voice, payment and OAuth routes are unchanged. No real client configuration is edited. Rollback uses a compatible core/playbooks pair through the existing delivery owners and disables this new ingress, retaining historical/native paths and receipts.
