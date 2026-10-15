/** Offline substitute for host SDK exports only. The real official provider
 * and its versioned MCP guard patch execute unchanged; no fetch reaches network.
 * This is not evidence that the production host's SDK has been qualified. */
export const DEFAULT_SEARCH_COUNT = 5;
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const normalizeOptionalString = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
export const normalizeBoundedOptionalString = (value, max) => typeof value === 'string' && value.length <= max ? value.trim() : undefined;
export const truncateUtf16Safe = (value, max) => value.slice(0, max);
export const resolveIntegerOption = (value, fallback, bounds) => Math.max(bounds.min, Math.min(bounds.max, value ?? fallback));
export const readStringParam = (args, key) => typeof args[key] === 'string' ? args[key] : undefined;
export const readStringArrayParam = (args, key) => args[key];
export const readPositiveIntegerParam = (args, key) => args[key];
export const resolveSearchCacheTtlMs = config => config.cacheTtlMinutes * 60000;
export const resolveSearchTimeoutSeconds = config => config.timeoutSeconds;
export const buildSearchCacheKey = value => JSON.stringify(value);
export const readCachedSearchPayload = () => undefined;
export const writeCachedSearchPayload = (_key, _value, ttl) => { if (ttl !== 0) throw new Error('cache must be disabled'); };
export const resolveSiteName = value => { try { return new URL(value).hostname; } catch { return ''; } };
export const wrapWebContent = value => `\n<<<EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>\nSource: Web Search\n---\n${value}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>`;
export const mergeScopedSearchConfig = config => config;
export const resolveProviderWebSearchPluginConfig = () => undefined;
export const createWebSearchProviderContractFields = () => ({});
export const createLazyRuntimeModule = load => { let loaded; return () => loaded ??= load(); };
export const readPluginPackageVersion = () => '2026.9.6';
export class ProviderHttpError extends Error { constructor(message, { status }) { super(message); this.status = status; } }
export const readProviderTextResponse = () => { throw new Error('unbounded reader used'); };
export const readResponseTextLimited = () => { throw new Error('raw error reader used'); };
export const withTrustedWebSearchEndpoint = async (request, callback) => {
  if (request.url !== 'https://search.parallel.ai/mcp' || request.init.method !== 'POST') throw new Error('unexpected destination');
  if (Object.keys(request.init.headers).some(key => /authorization|cookie/i.test(key))) throw new Error('unexpected credential');
  request.signal?.throwIfAborted();
  const response = await globalThis.__parallelNativeFetch(request);
  return callback(response);
};
