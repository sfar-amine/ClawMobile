// Keep the old static Bearer client path unchanged; everything else is handled
// by the OAuth resource server only when configured. Never infer auth from headers.
export function useLegacyMcpAuth(result) {
  return result?.ok === true && typeof result.clientId === 'string' &&
    (result.profile === 'chat-owner' || result.profile === 'chat-owner-shadow');
}
