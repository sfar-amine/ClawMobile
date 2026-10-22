import { OAuthResourceServer } from '@cloudflare/workers-oauth-provider';
import { chatgptReadAllowed } from './chatgpt-oauth-policy.mjs';

// Candidate adapter, not mounted on the active relay. The authorization service
// must be bound before activation. Never reuse the Claude/Codex static tokens.
export const CHATGPT_RESOURCE = 'https://claw-voice-relay.claw-s24-voice-260930.workers.dev/mcp';
export const CHATGPT_ISSUER = 'https://claw-chatgpt-oauth.claw-s24-voice-260930.workers.dev';

export function createChatgptOAuthResource(invokeMcp) {
  if (typeof invokeMcp !== 'function') throw new TypeError('mcp_handler_required');
  return new OAuthResourceServer({
    resourceMetadata: {resource: CHATGPT_RESOURCE, authorization_servers: [CHATGPT_ISSUER]},
    requiredScopes: ['mcp:read'],
    validateToken: (env) => async (audience, token) => {
      const validator = env.CHATGPT_AUTH_SERVER?.validateToken;
      if (typeof validator !== 'function') return null;
      return env.CHATGPT_AUTH_SERVER.validateToken(audience, token);
    },
    handler: {
      async fetch(request, env, ctx) {
        if (!chatgptReadAllowed(ctx?.auth, ctx?.props, ctx?.props?.userId)) {
          return Response.json({error:'forbidden'}, {status:403});
        }
        return invokeMcp(request, env, {ok:true, clientId:'chatgpt', profile:'chat-owner-shadow'});
      },
    },
  });
}
