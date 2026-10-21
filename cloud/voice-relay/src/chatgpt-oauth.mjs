import { OAuthResourceServer } from '@cloudflare/workers-oauth-provider';
import { chatgptReadAllowed } from './chatgpt-oauth-policy.mjs';

// Dedicated resource server for ChatGPT. Does NOT admit any bearer by itself.
// Authorization server binding is configured separately; fail closed otherwise.
const resource = 'https://claw-voice-relay.claw-s24-voice-260930.workers.dev/mcp';
const issuer = 'https://claw-chatgpt-oauth.claw-s24-voice-260930.workers.dev';

export const chatgptOAuthResource = new OAuthResourceServer({
  resourceMetadata: { resource, authorization_servers: [issuer] },
  requiredScopes: ['mcp:read'],
  validateToken: (env) => async (audience, token) => {
    if (!env.CHATGPT_AUTH_SERVER || typeof env.CHATGPT_AUTH_SERVER.validateToken !== 'function') return null;
    return env.CHATGPT_AUTH_SERVER.validateToken(audience, token);
  },
  handler: {
    async fetch(request, env, ctx) {
      const authorized = chatgptReadAllowed(ctx?.auth, ctx?.props, env.CHATGPT_OWNER_SUBJECT);
      if (!authorized) return Response.json({ error: 'forbidden' }, { status: 403 });
      if (typeof env.CHATGPT_MCP_HANDLER !== 'function') {
        return Response.json({ error: 'handler_unavailable' }, { status: 503 });
      }
      return env.CHATGPT_MCP_HANDLER(request, {
        ok: true, clientId: 'chatgpt', profile: 'chat-owner-shadow'
      });
    }
  }
});
