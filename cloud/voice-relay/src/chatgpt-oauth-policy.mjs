/** Authorization beyond OAuth: fail closed unless verified owner and read scope. */
export function chatgptReadAllowed(auth, props, ownerSubject) {
  return typeof ownerSubject === 'string' && ownerSubject.length > 0 &&
    typeof props?.userId === 'string' && props.userId === ownerSubject &&
    Array.isArray(auth?.scope) && auth.scope.includes('mcp:read');
}
