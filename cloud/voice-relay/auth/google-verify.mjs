import { createRemoteJWKSet, jwtVerify } from 'jose';
import { googleOwnerClaimAllowed } from './google-oidc.mjs';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyGoogleOwnerIdToken(token, expectedClientId, expectedSubject, nonce) {
  if (!token || !expectedClientId || !expectedSubject || !nonce) throw new Error('identity_config_missing');
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ['https://accounts.google.com','accounts.google.com'],
    audience: expectedClientId,
    algorithms: ['RS256'],
  });
  const googleIdentity = expectedSubject.includes('@') ? (payload.email_verified === true && payload.email === expectedSubject) : payload.sub === expectedSubject;
  if (!googleIdentity || !googleOwnerClaimAllowed(payload,expectedClientId,payload.sub) || payload.nonce!==nonce) {
    throw new Error('google_owner_validation_failed');
  }
  return expectedSubject.includes('@') ? payload.email : payload.sub;
}
