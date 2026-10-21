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

## Reuse audit / latest review
- No Cloudflare Access setup or third-party OAuth identity-provider configuration identified in the repository's non-dependency sources. This does not prove absence in the Cloudflare account.
- Direct Cloudflare account inspection was rejected by security controls; it was not retried through another path.
- Candidate resource adapter uses dependency injection for the canonical MCP handler rather than an impossible function-valued Worker environment binding. Dedicated token validator binding remains mandatory and fail-closed.
- Isolated resource module dry-run compiles; existing relay tests and six-case owner policy tests pass. No OAuth authorization server / real login / consent or deployed route is present. Nothing is activated in production.

## Authorization foundation without Zero Trust or payment card
- Added `cloud/voice-relay/auth/index.mjs`: official Cloudflare OAuthAuthorizationServer foundation, RFC 8414 discovery and OAuth protocol handlers, scope `mcp:read`, protected resource constrained to the canonical existing `/mcp` URL.
- `/authorize` deliberately rejects with HTTP 503 (`owner_identity_not_configured`) until independent owner identity and explicit consent are properly implemented. It cannot issue an access token as-is. No fake OAuth login or anonymous consent.
- `wrangler.auth-check.jsonc` dry-run build passes; no KV namespace/binding configured, no live provider deployment, and no production change. This is NOT a working OAuth authorization flow.
- Do not use Zero Trust setup or provide a payment card. Identity decision and OAuth consent implementation remain prerequisites.

## Google OIDC OAuth authorization implementation (current branch)
- Uses upstream Google OIDC in the existing Google Cloud project with OAuth authorization-code + PKCE S256, browser-bound upstream state from the Cloudflare library, and explicit browser consent.
- Uses `jose` remote Google JWKS for RS256 cryptographic verification, verifies issuer, audience, expiration, nonce, email verification and one configured Google subject.
- OAuth `mcp:read` only, with dedicated resource audience and subject-bound encrypted grant props. Errors deny access; no anonymous fallback.
- Development checks: both isolated policy suites pass (8 and 6 cases), existing relay npm tests pass, separate authorization worker dry-run compile passes.
- Production remains unchanged. NO real Google sign-in or token exchange has been exercised. Cloudflare Workers KV namespace is not configured; Google secrets are on the existing voice-relay Worker, not on the future authorization Worker; Google owner subject is not configured; OAuth resource adapter is not mounted into the active MCP route. Activation is forbidden until these and S24/ChatGPT end-to-end tests are satisfied.

## Cloudflare KV provisioned
- Account namespace `SAMANTHA_CHATGPT_OAUTH` created successfully, id `8611ec4eca474e939eaf3beb6f558d94` (not a secret).
- Authorization Worker staging config maps this namespace as `OAUTH_KV`.
- Cloudflare dry-run confirms KV binding. Google claim tests 8/8, ChatGPT owner policy tests 6/6, existing relay tests PASS.
- No Worker deployed. OAuth secrets are still on `claw-voice-relay` rather than the future authorization Worker, and Google owner subject has not been configured. Real end-to-end approval and existing MCP route integration still required. Do not claim integration active.

## MCP routing regression correction
- The previous direct top-level Cloudflare OAuthResourceServer import caused Node's `ERR_UNSUPPORTED_ESM_URL_SCHEME` in legacy tests. Fixed through conditional dynamic import in the OAuth-only route.
- Kept legacy authenticated Bearer path as first match; OAuth branch is admitted only when both dedicated validator service binding and owner subject are present. Unsupported credentials fail closed when OAuth is not configured.
- Canonical MCP handler now accepts an internally supplied verified OAuth identity (not client-provided JSON), and reuses the same deterministic Capability Graph, receipts and read-only profile.
- Added RFC 9728 discovery delegation gated on the same configuration. Existing `npm test` PASS, 6 legacy routing-policy tests PASS, resource and Google claim policy suites previously PASS; Worker dry-run PASS.
- This is a branch-only candidate, not a production OAuth acceptance. Binding, Google secret placement, owner subject, consent E2E and ChatGPT approval are still outstanding. Nothing deployed.
