/** Authorization beyond OAuth: fail closed unless verified owner and read scope. */
export function chatgptReadAllowed(auth, props, ownerSubject) {
  return typeof ownerSubject === 'string' && ownerSubject.length > 0 &&
    typeof props?.userId === 'string' && props.userId === ownerSubject &&
    Array.isArray(auth?.scope) && auth.scope.includes('mcp:read');
}

/** Explicit browser consent creates a new grant; legacy read tokens stay read-only. */
export function chatgptGrant(access) {
  if (!['read', 'owner'].includes(access)) throw new TypeError('invalid_consent_access');
  return {scope: access === 'owner' ? ['mcp:read', 'mcp:owner'] : ['mcp:read'],
    access, ownerConsentVersion: access === 'owner' ? 1 : 0};
}

export function chatgptProfile(auth, props, ownerSubject) {
  if (!chatgptReadAllowed(auth, props, ownerSubject)) return null;
  const ownerScope = auth.scope.includes('mcp:owner');
  const ownerConsent = props.access === 'owner' && props.ownerConsentVersion === 1;
  if (ownerScope !== ownerConsent) return null;
  return ownerScope ? 'chat-owner' : 'chat-owner-shadow';
}
