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

## 2026-10-21 auth Worker deployment
- Fixed missing `WorkerEntrypoint` import from `cloudflare:workers`, caught by actual Cloudflare deploy validation (dry-run alone had missed it).
- Dedicated OAuth authorization Worker deployed successfully as `claw-chatgpt-oauth`, Cloudflare version `ec9d5258-e5fa-4c40-b397-8fbec1471422`, with existing isolated KV namespace bound.
- Live `/authorize` returns HTTP 503 intentionally because Google OAuth Web credentials and authorized owner subject have not yet been injected into this distinct Worker. Do not interpret this as completed OAuth login.
- Relay Worker NOT deployed or modified in production. Wrangler config now specifies the eventual authenticated service binding but remains branch-only. All existing relay Node tests and 14 targeted policy checks pass.
- Required for closing: configure auth Worker `GOOGLE_OAUTH_WEB_CLIENT_ID`, `GOOGLE_OAUTH_WEB_CLIENT_SECRET`, `GOOGLE_OWNER_SUBJECT`; relay `CHATGPT_OWNER_SUBJECT` aligned with Google identity; then deploy relay and run actual ChatGPT OAuth -> S24 MCP acceptance. Never copy protected production secrets into model output.

## Live deploy after Google credentials (2026-10-21)
- Verified `GOOGLE_OAUTH_WEB_CLIENT_ID`, `GOOGLE_OAUTH_WEB_CLIENT_SECRET`, `GOOGLE_OWNER_IDENTITY` secret names present on dedicated auth Worker (never exposed values).
- Relay now trusts only OAuth library validated token bound to the dedicated auth Worker (audience, scope, expiry) and verified user props; the auth Worker checks Google signature, issuer, intended audience, nonce, owner identity before issuing such a token. No separate relay-side owner secret duplicated.
- Production relay deployed, Worker version `756f85d3-5361-4521-bf14-d819b7a1caa0`.
- Live endpoint checks: `/.well-known/oauth-protected-resource/mcp` HTTP 200; `/mcp` unauthenticated HTTP 401; OAuth authorization metadata HTTP 200. Both Claude and Codex existing Bearer credentials list MCP tools successfully after deploy.
- Final acceptance still requires user-driven ChatGPT OAuth consent and one genuine read invocation through ChatGPT to S24. No automatic write authorization granted.

## 2026-10-22 RPC correction
- Reproduced the active adapter in local Workerd with a real service binding: `validator.call(binding, audience, token)` returns 503 for both valid and invalid fixture tokens. Direct `binding.validateToken(audience, token)` returns 200/401 respectively. Fix is confined to this one invocation.
- Added `test-chatgpt-oauth-rpc.mjs`, registered in CI: actual relay/Durable Object + OAuth adapter + synthetic authorization Worker. Eight cases cover anonymous, invalid, expired, wrong audience, wrong scope, valid OAuth tools/list exposing claw_context without claw_exec, and unchanged Claude/Codex static owner tool lists. Fails on old code, passes on fix.
- Executed off-phone on Windows: above regression, npm test, legacy routing (6), owner policy (6), long-action pending test all pass. Full repository localci and independent review are not claimed.
- Production baseline verified: version 756f85d3-5361-4521-bf14-d819b7a1caa0. Rollback: restore that Worker version. No secrets, grants, scopes, authorization Worker or legacy identities changed.
- Architecture/capability impact: none; same service binding and canonical MCP schemas/tools. Only OAuth adapter invocation changes. MCP schemas, S24 executors, registry and permissions unchanged.
- Live ChatGPT refresh and S24 receipt still pending at this checkpoint. Local fixture token validation is not real owner OAuth acceptance.

## Real OAuth acceptance — 22 October 2026
- After Refresh tools, the actual Samantha plugin exposes five read/shadow tools, including claw_context.
- Direct invocation through `mcp__codex_apps__samantha_claw_context` succeeded: state=context, client_id=chatgpt, profile=chat-owner-shadow, owner=false, read_only=true, surface=chat, session=mcp-chatgpt, toRevision=3169, duration_ms=227.52. The context is paginated (partial=true); this is transport acceptance, not a claim that all memory was read.
- Non-sensitive returned evidence is in chatgpt-mcp-oauth-rpc-20261022-evidence.json. This is the real OAuth plugin response, not the local fixture or Codex static client. claw_context itself has no action receipt ID.
- Deployment b13f3471-ad4f-4d3b-87bd-a10f6a6ce2b4 is confirmed; static Codex live execution remains healthy. Claude/Codex static routing is covered by the local regression; their credentials were untouched.
- Source branch exact SHA 24b6f354 was verified with git ls-remote. Historical ClawMobile main has diverged extensively: a draft comparison was closed without merge; no unrelated integration attempted.
- No OpenAI paid API, billing enrollment, new secrets or permission expansion.
