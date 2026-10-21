# ChatGPT MCP — OAuth 2.1 integration checkpoint (2026-10-21)

## Goal
Connect ChatGPT Web to the existing S24 MCP gateway without OpenAI API billing, preserving the existing Claude and Codex Bearer credentials, exact Capability Graph routing, idempotent Remote Bridge receipts, and human confirmation boundaries.

## Verified facts
- Existing Cloudflare Workers relay: `cloud/voice-relay` exposes Streamable HTTP `/mcp`, with per-client Bearer SHA-256 configuration `MCP_CLIENTS_JSON`.
- Existing two identities `claude-chat` and `codex-cloud` successfully list MCP tools. Do not rotate or modify these credentials.
- ChatGPT custom MCP UI offers OAuth, No authentication, and OAuth or no authentication; custom static Bearer header is unavailable.
- Anonymous access must never be enabled for private Samantha data or actions.
- `@cloudflare/workers-oauth-provider` installed as the Cloudflare-supported OAuth 2.1 library; baseline relay test suite passes unchanged.

## Implementation boundary
Use a dedicated authorization server Worker, with its own isolated KV namespace. Publish protected-resource metadata for the MCP resource and RFC 8414 OAuth authorization server discovery, with PKCE S256 and ChatGPT CIMD. The authorization endpoint MUST authenticate the actual owner through a verified identity provider, show informed consent, enforce a single authorized subject, and grant only `mcp:read` initially. Token validation MUST verify issuer, resource audience, expiry and scope before forwarding to existing MCP routing. Map OAuth identity to a distinct `chatgpt` shadow client; never reuse Claude/Codex Bearer token or accept an OAuth token as an arbitrary existing static credential.

The existing `/mcp` endpoint and two Bearer clients must be regression-tested unchanged. The fail-closed behavior must be tested for missing/expired/incorrect-audience tokens, missing scope, unknown owner identity, invalid PKCE and unauthorized mutations. Activation requires independent real ChatGPT login + consent + S24 receipt read, then a production deploy/rollback plan.

## Explicit open dependency
No verified owner identity provider, callback configuration, or Cloudflare Access policy is provisioned in this change. The OAuth library is not itself an identity provider. Do not fabricate authentication, auto-consent, or deploy an unauthenticated authorization endpoint. No OAuth service or ChatGPT plugin has been activated.

## Current delivery status
Isolated branch + dependency only. Existing production untouched. NEXT: configure and verify owner identity provider/policy, implement authorization Worker and resource validation, write tests, then stage live acceptance before deployment.

## Subsequent work, 21 October 2026
- Added isolated `cloud/voice-relay/src/chatgpt-oauth.mjs` Resource Server module using Cloudflare's official OAuth resource validator. It requires a dedicated service binding `CHATGPT_AUTH_SERVER` and a verified configured `CHATGPT_OWNER_SUBJECT`; no anonymous fallback. Produces a `chat-owner-shadow` context only on validated owner + `mcp:read` scope.
- Added isolated policy module and six-case security-oriented policy test.
- Worker dry-run builds for existing relay and isolated OAuth resource module pass. Existing `npm test` passes. No identity provider is yet configured. No OAuth authorization server or MCP routing wiring has been deployed; the isolated resource module is not imported by the active Worker.
- No OAuth login/consent or live ChatGPT verification performed. Blocker remains verified identity provider and proper authorization-server implementation.
