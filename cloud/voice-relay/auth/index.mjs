import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';

// OAuth 2.1 authorization-server foundation. Never grants access without a
// verified upstream owner identity. Cloudflare Access is NOT required.
const ISSUER = 'https://claw-chatgpt-oauth.claw-s24-voice-260930.workers.dev';
const RESOURCE = 'https://claw-voice-relay.claw-s24-voice-260930.workers.dev/mcp';
export const oauth = new OAuthAuthorizationServer({
  issuer: ISSUER,
  resources: [RESOURCE],
  scopesSupported: ['mcp:read'],
  clientIdMetadataDocumentEnabled: true,
});

export default class ChatgptOAuthServer extends WorkerEntrypoint {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/authorize') {
      // Requires an independently verified owner identity/session and an
      // informed consent page before calling completeAuthorization().
      // Failing closed is mandatory while that identity bridge is unavailable.
      return Response.json({ error: 'owner_identity_not_configured' }, {
        status: 503,
        headers: {'cache-control':'no-store'}
      });
    }
    return oauth.fetch(request, this.env, this.ctx);
  }
  validateToken(resource, token) {
    return oauth.validateToken(resource, token, this.env);
  }
}
