// Google identity assertions for the ChatGPT MCP upstream sign-in.
// ID token validity MUST be established using Google's public JWKS in a
// signature-verifying JWT library before this claim policy is called.
export function googleOwnerClaimAllowed(claims, expectedClientId, expectedSubject) {
  if (!claims || typeof claims !== 'object') return false;
  if (!expectedClientId || !expectedSubject) return false;
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return false;
  if (claims.aud !== expectedClientId || claims.sub !== expectedSubject) return false;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now()/1000)) return false;
  if (claims.email_verified !== true) return false;
  return true;
}
export function googleOAuthSettings(env) {
  const clientId = String(env.GOOGLE_OAUTH_WEB_CLIENT_ID || '');
  const secret = String(env.GOOGLE_OAUTH_WEB_CLIENT_SECRET || '');
  const subject = String(env.GOOGLE_OWNER_SUBJECT || '');
  if (!clientId || !secret || !subject) return null;
  return { clientId, secret, subject };
}
