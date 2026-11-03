# MCP service scope — private contract

Public selector: `{ "schema_version": "mcp-service.v1", "domain_id": "pulse" }`, with exactly these fields. It is optional only for historical calls without `client_context`. Supplying either new field opts into closed admission. A service selector without context is refused.

Server configuration: the existing authenticated client record may contain `interpretation_services: ["pulse"]`. Missing means no services; null, duplicates, unknown values and non-arrays refuse authentication. Only the server-owned list can admit the selector. No deployment or configured client is changed by this source patch.

Existing owner chain: Worker authenticated record → exact relay frame → C12 WeakMap → canonical public packet `{request, client_context, service_scope}` → private `mcp-host-context.v2` header → existing peer/UID validation → typed playbooks context capability. The header must match the selector and canonical packet digest, with owner profile and request/client/thread linkage and maximum TTL 30 seconds. No source bodies enter a header or receipt.

The playbooks capability carries `service_domain` and a process-private integrity MAC covering home, canonical core root, request, principal, verification reference, both timestamps and service. Existing legacy capabilities retain their original read use; they cannot be upgraded by copying. MCP factory and per-turn validation precede Graph/governor/private projection. The complete canonical Pulse catalogue is passed internally, without lexical classification.

Failures include `MCP_INTERPRETATION_SERVICE_REQUIRED` and `MCP_INTERPRETATION_SERVICE_UNVERIFIED`; they are terminal for the new input and do not create a legacy retry. Successful scope admission still permits `DATA_PROFILE_UNVERIFIED`, with no model call.

Verification is synthetic/Recorded MOCK only, with actual owner boundaries and paired source receipts; it is not LIVE DATA/provider qualification. The immutable paired source pin and canonical exact-head PR CI are recorded in the delivery note. No new route/capability or business grant exists.
