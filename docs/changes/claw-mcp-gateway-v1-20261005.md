# Claw MCP Gateway V1 — 5 October 2026

## Scope

Implement the provider-neutral MCP ingress approved for Claude, Grok and future compatible external clients while preserving Samantha's native local path.

## Runtime changes

- Existing Cloudflare Worker/Durable Object relay now exposes authenticated `POST /mcp`.
- The edge uses `@modelcontextprotocol/sdk@1.32.1` with `WebStandardStreamableHTTPServerTransport` in stateless JSON-response mode.
- Client auth is per-client bearer with SHA-256 hashes stored in the edge `MCP_CLIENTS_JSON` secret configuration.
- V1 profile is `chat-owner-shadow`.
- Five generic MCP tools are exposed: context, resolve, execute, status and artifact read.
- The existing outbound S24 WebSocket transports `mcp_request` messages; no inbound Android port is opened.
- Companion adds `mcpBridge.ts`, which maps tools to existing context/Capability Harness/Remote Bridge owners.
- Remote Bridge adds one internal `mcp_capability_execute_readonly` method so MCP execution uses the canonical durable receipt and task/step deduplication.
- V1 execution fails closed unless the Capability Graph selects a deterministic, owner-authorized, read-only route with no confirmation.

## Boundaries preserved

- Companion remains loopback-only on the S24.
- Samantha Android does not use the remote MCP path.
- No MCP-specific memory, route registry, scheduler, retry engine, artifact store, daemon or Governor was created.
- Existing Voice Relay reconnect/heartbeat ownership remains unchanged.
- Remote Desktop Commander remains independent break-glass/repair access.
- Biometrics, OTP, CAPTCHA and banking verification are not exposed through MCP.

## Local validation

Passed during implementation:

- edge voice relay regression;
- MCP SDK initialize/tools/list/tools/call/auth tests;
- TypeScript plugin build;
- Remote Bridge core regression;
- Voice Relay regression;
- Cloudflare Wrangler dry-run bundle;
- Companion MCP bridge test covering external_mcp resolution, durable read receipt, status, artifact and context bundle;
- simulated end-to-end MCP SDK -> edge Durable Object -> outbound-device message -> Companion mcpBridge -> Capability Graph/Remote Bridge, including fail-closed write request.

The Cloudflare dry-run bundle is about 878 KiB uncompressed / 168 KiB gzip in this implementation environment.

## Deployment state

Source implementation only until the edge Worker and S24 runtime are explicitly deployed and verified. A real Claude/Grok invocation is required before claiming external E2E validation.

## Rollback

Revert this scoped change or disable/remove the MCP client secret/edge route. Existing voice, Samantha, Slack Remote Bridge and RDC paths remain usable.
