#!/usr/bin/env node
/** W1: request-scoped adapter to the pinned native OpenClaw provider.
 * No HTTP client, provider fallback, model call, global config mutation or cache.
 * Local env selects an integrator-installed package, never a path in public JSON.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as nodeModule from 'node:module';
const { createRequire } = nodeModule;
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_INPUT_BYTES = 16384;
const MAX_OUTPUT_BYTES = 65536;
const MAX_BUDGET_MS = 12000;
const PROVIDER = 'parallel-free';
const SAFE_MESSAGES = Object.freeze({
  invalid_request: 'La demande de recherche est invalide.',
  provider_unavailable: 'Le fournisseur gratuit n’est pas installé ou qualifié.',
  provider_integrity: 'Le fournisseur gratuit ne correspond pas à la version qualifiée.',
  provider_contract: 'Le fournisseur a renvoyé une réponse non conforme.',
  provider_response_too_large: 'La réponse du fournisseur dépasse la limite autorisée.',
  rate_limited: 'Le fournisseur gratuit limite temporairement les recherches.',
  access_denied: 'Le fournisseur gratuit refuse cet accès.',
  provider_failed: 'Le fournisseur gratuit est temporairement indisponible.',
  timeout: 'La recherche a dépassé son délai.',
  cancelled: 'La recherche a été annulée.',
  insufficient_sources: 'Aucune source publique exploitable n’a été obtenue.',
  sources_filtered: 'Certaines sources renvoyées n’étaient pas exploitables.',
});
class PublicWebError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; Object.assign(this, extra); }
}
function fail(code, extra) { throw new PublicWebError(code, extra); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function cleanText(value, limit) {
  if (typeof value !== 'string') fail('provider_contract');
  // Keep source text as untrusted data. Remove UI controls, not words/intents.
  const points = Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '')).slice(0, limit);
  // The consumers bound the same text in UTF-16 units (TypeScript projection, Kotlin app), so an emoji or
  // other astral character made a 1500-code-point excerpt 1501 units long and the whole run was refused
  // (S24 17/10, Samsung query). Drop whole code points until both bounds hold; never split a surrogate pair.
  while (points.join('').length > limit) points.pop();
  return points.join('');
}
export function validateRequest(value) {
  if (!isObject(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_INPUT_BYTES) fail('invalid_request');
  const allowed = new Set(['version', 'operation', 'query', 'sessionId', 'remainingBudgetMs', 'count', 'freshness', 'searchQueries', 'objective']);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.version !== 1 || value.operation !== 'search') fail('invalid_request');
  if (typeof value.query !== 'string' || !value.query.trim() || Array.from(value.query).length > 1000 || /[\u0000-\u001f\u007f]/u.test(value.query)) fail('invalid_request');
  // An opaque technical conversation UUID only. No external identity is accepted.
  if (typeof value.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sessionId)) fail('invalid_request');
  if (!Number.isInteger(value.remainingBudgetMs) || value.remainingBudgetMs < 1 || value.remainingBudgetMs > MAX_BUDGET_MS || value.count !== 5) fail('invalid_request');
  if (value.freshness !== undefined && !['current', 'recent'].includes(value.freshness)) fail('invalid_request');
  const queries = value.searchQueries ?? [value.query];
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 3 || queries.some(query => typeof query !== 'string' || !query.trim() || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query))) fail('invalid_request');
  const objective = value.objective ?? value.query;
  if (typeof objective !== 'string' || !objective.trim() || objective.length > 5000 || /[\u0000-\u001f\u007f]/u.test(objective)) fail('invalid_request');
  return Object.freeze({ ...value, query: value.query.trim(), objective: objective.trim(), searchQueries: queries.map(query => query.trim()) });
}

/** Only URL validation for presentation. This module never fetches these URLs.
 * DNS/redirect checks remain mandatory before optional fetch in a future lot.
 */
export function publicSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  let url; try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal|home|lan)$/u.test(hostname) || !hostname.includes('.') && !net.isIP(hostname)) return null;
  if (net.isIP(hostname) === 4) {
    const [a,b] = hostname.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224 || a === 198 && [18,19].includes(b)) return null;
  }
  // A public search source never needs a literal IPv6 host in this pilot.
  if (net.isIP(hostname) === 6) return null;
  // Signed URLs and common credentials cannot be sent to UI/history as sources.
  if ([...url.searchParams.keys()].some(key => /^(?:access_token|id_token|token|auth|authorization|api[_-]?key|password|secret|sig|signature|x-amz-.+|x-goog-.+)$/i.test(key))) return null;
  url.hash = '';
  return url.href;
}

function unwrapNativeText(value) {
  if (typeof value !== 'string') fail('provider_contract');
  // Exact native 2026.9.6 wrapper. Its content remains explicitly untrusted in
  // the canonical envelope; this only removes renderer-facing boundary syntax.
  const match = /^\s*<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\nSource: Web Search\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/u.exec(value);
  if (!match) fail('provider_contract');
  return match[2];
}
function publicationDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 50 || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value) || !Number.isFinite(Date.parse(value))) return null;
  // Reject impossible calendar dates instead of accepting Date.parse rollover.
  const day = value.slice(0, 10);
  if (new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) return null;
  return value;
}
export function normalizeResult(result, retrievedAt) {
  if (!isObject(result) || result.provider !== PROVIDER || !Array.isArray(result.results) || result.results.length > 5 || result.externalContent?.untrusted !== true || result.externalContent?.wrapped !== true) fail('provider_contract');
  const sources = [];
  const seen = new Set();
  let rejected = 0;
  for (const source of result.results) {
    if (!isObject(source)) fail('provider_contract');
    const url = publicSourceUrl(source.url);
    if (!url || seen.has(url)) { rejected++; continue; }
    const title = cleanText(unwrapNativeText(source.title), 300);
    const excerpts = Array.isArray(source.excerpts) ? source.excerpts : [];
    if (excerpts.some(value => typeof value !== 'string') || excerpts.length > 100) fail('provider_contract');
    const excerpt = cleanText(excerpts.map(unwrapNativeText).join('\n\n'), 1500);
    if (!title.trim()) { rejected++; continue; }
    seen.add(url);
    sources.push({ id: `s${sources.length + 1}`, title, url, searchRetrievedAt: retrievedAt, publishedAt: publicationDate(source.published), excerpt, evidenceType: 'search_excerpt', untrusted: true });
  }
  return { sources, rejected };
}

// A compatibility resolver scoped to this one request process and to the
// integrity-checked plugin files only. Node does not use the host's jiti aliases
// when importing an independently installed plugin by file URL.
let nativeResolver;
async function registerNativeSdkResolver(root, hostRoot, hostRequire, pin) {
  if (nativeResolver) {
    if (nativeResolver.root !== root || nativeResolver.hostRoot !== hostRoot) fail('provider_integrity');
    return;
  }
  const sdkNames = new Set([
    'extension-shared', 'lazy-runtime', 'logging-core', 'number-runtime',
    'plugin-entry', 'provider-http', 'provider-web-search',
    'provider-web-search-contract', 'security-runtime', 'string-coerce-runtime',
    'text-utility-runtime',
  ].map(name => `openclaw/plugin-sdk/${name}`));
  const parents = new Set(Object.keys(pin.hardenedFiles)
    .filter(name => /\.(?:m?js)$/u.test(name))
    .map(name => pathToFileURL(path.join(root, name)).href));
  const targets = new Map();
  for (const specifier of sdkNames) {
    const target = await fs.realpath(hostRequire.resolve(specifier));
    const relative = path.relative(hostRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('provider_integrity');
    targets.set(specifier, pathToFileURL(target).href);
  }
  if (typeof nodeModule.registerHooks !== 'function') fail('provider_unavailable');
  const hook = nodeModule.registerHooks({ resolve(specifier, context, nextResolve) {
    if (parents.has(context.parentURL) && targets.has(specifier)) {
      return { url: targets.get(specifier), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  nativeResolver = { root, hostRoot, hook };
}
async function resolveHostSdk(root) {
  let hostRequire = createRequire(path.join(root, 'package.json'));
  let sdkEntry;
  try { sdkEntry = hostRequire.resolve('openclaw/plugin-sdk/provider-web-search'); }
  catch (error) {
    // Reuse the already qualified host discovery owner; no npm install,
    // guessed global directory, or second CLI/package-root resolver.
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    // An existing but partial local host cannot be bypassed by another install.
    for (const directory of hostRequire.resolve.paths('openclaw') ?? []) {
      try {
        if ((await fs.stat(path.join(directory, 'openclaw'))).isDirectory()) fail('provider_integrity');
      } catch (localError) { if (localError instanceof PublicWebError) throw localError; }
    }
    // runtime-sync/lib.sh deploy this owner separately from Tier0 termux-lite.
    const stateDirectory = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
    if (!path.isAbsolute(stateDirectory)) fail('provider_unavailable');
    const ownerFile = path.join(stateDirectory, 'extensions/openclaw-plugin-mobile-ui/dist/companion/ownerTurnGateway.js');
    const owner = createRequire(import.meta.url)(await fs.realpath(ownerFile));
    if (typeof owner.installedPackageRoot !== 'function') fail('provider_integrity');
    const installed = await owner.installedPackageRoot(process.env.CLAWMOBILE_OPENCLAW_BIN || 'openclaw');
    hostRequire = createRequire(path.join(installed.root, 'package.json'));
    sdkEntry = hostRequire.resolve('openclaw/plugin-sdk/provider-web-search');
  }
  let hostRoot = path.dirname(sdkEntry);
  while (hostRoot !== path.dirname(hostRoot)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
      if (manifest.name === 'openclaw') return { hostRequire, sdkEntry, hostRoot: await fs.realpath(hostRoot), hostVersion: manifest.version };
    } catch {}
    hostRoot = path.dirname(hostRoot);
  }
  fail('provider_unavailable');
}

/** The only production loader. No path/provider/config comes from request JSON. */
export async function loadNativeProvider() {
  const pluginDirectory = process.env.CLAW_WEB_PARALLEL_PLUGIN_DIR;
  if (!pluginDirectory || !path.isAbsolute(pluginDirectory)) fail('provider_unavailable');
  try {
    const root = await fs.realpath(pluginDirectory);
    const pin = JSON.parse(await fs.readFile(path.join(HERE, 'openclaw-compat/parallel-free/pin.json'), 'utf8'));
    for (const [name, expected] of Object.entries(pin.hardenedFiles)) {
      const filename = path.join(root, name);
      if ((await fs.lstat(filename)).isSymbolicLink() || hash(await fs.readFile(filename)) !== expected) fail('provider_integrity');
    }
    const { hostRequire, sdkEntry, hostRoot, hostVersion } = await resolveHostSdk(root);
    if (hostVersion !== pin.hostVersion) fail('provider_integrity');
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major === 24 && minor >= 16 || major === 26 && minor >= 1 || major > 26)) fail('provider_unavailable');
    const configEntry = hostRequire.resolve('openclaw/plugin-sdk/config-runtime');
    const configOwner = await import(pathToFileURL(configEntry).href);
    if (typeof configOwner.loadConfig !== 'function') fail('provider_integrity');
    const config = await configOwner.loadConfig();
    // Respect administrative disable/allow rules without passing credentials or
    // any global provider choice into the scoped public-search tool.
    if (!isObject(config) || config.tools?.web?.search?.enabled === false || config.plugins?.enabled === false ||
        config.plugins?.entries?.parallel?.enabled === false ||
        Array.isArray(config.plugins?.allow) && config.plugins.allow.length > 0 && !config.plugins.allow.includes('parallel') ||
        Array.isArray(config.plugins?.deny) && config.plugins.deny.includes('parallel')) fail('access_denied');
    const sdk = await import(pathToFileURL(sdkEntry).href);
    const searchConfig = Object.freeze({ provider: PROVIDER, maxResults: 5, cacheTtlMinutes: 0, timeoutSeconds: 12 });
    if (typeof sdk.resolveSearchCacheTtlMs !== 'function' || sdk.resolveSearchCacheTtlMs(searchConfig) !== 0) fail('provider_integrity');
    await registerNativeSdkResolver(root, hostRoot, hostRequire, pin);
    const module = await import(pathToFileURL(path.join(root, 'dist/web-search-provider.js')).href);
    const provider = module.createParallelFreeWebSearchProvider();
    if (provider.id !== PROVIDER || provider.requiresCredential !== false || provider.envVars?.length !== 0) fail('provider_integrity');
    const tool = provider.createTool({ config: { tools: { web: { search: searchConfig } } }, searchConfig });
    if (typeof tool.execute !== 'function') fail('provider_integrity');
    return tool;
  } catch (error) {
    if (error instanceof PublicWebError) throw error;
    fail('provider_unavailable');
  }
}
function classify(error, abortedCode) {
  if (abortedCode) return { code: abortedCode };
  if (error instanceof PublicWebError) return { code: error.code };
  const status = error?.status ?? error?.statusCode;
  if (status === 429) return { code: 'rate_limited', retryAfterMs: Number.isFinite(error.retryAfterMs) ? Math.max(0, Math.min(error.retryAfterMs, 3600000)) : null };
  if (status === 403 || status === 401) return { code: 'access_denied' };
  if (error?.message === 'parallel_mcp_response_too_large') return { code: 'provider_response_too_large' };
  if (typeof error?.message === 'string' && /^(?:parallel_mcp_(?:invalid_response|correlation_failed|initialize_invalid|tool_failed))$/u.test(error.message)) return { code: 'provider_contract' };
  return { code: 'provider_failed' };
}
export async function executeSearch(input, { loadProvider = loadNativeProvider, signal, now = () => new Date().toISOString() } = {}) {
  const started = performance.now();
  const controller = new AbortController();
  let timeout;
  let abortedCode;
  const cancel = () => { abortedCode = 'cancelled'; controller.abort(new Error('cancelled')); };
  const base = { version: 1, provider: PROVIDER, providerAuth: 'anonymous', sources: [], externalContent: { untrusted: true, source: 'web_search' }, metrics: { searchMs: null, logicalSearchCalls: 0, transportPosts: null, cacheHit: false }, error: null };
  try {
    const request = validateRequest(input);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const remaining = request.remainingBudgetMs - (performance.now() - started);
    if (remaining <= 0) fail('timeout');
    timeout = setTimeout(() => { abortedCode = 'timeout'; controller.abort(new Error('timeout')); }, remaining);
    const abortPromise = new Promise((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    controller.signal.throwIfAborted();
    const tool = await Promise.race([loadProvider(), abortPromise]);
    controller.signal.throwIfAborted();
    // Timers can be delayed by synchronous module/config work. Check the
    // monotonic deadline again before allowing the first transport call.
    if (performance.now() - started >= request.remainingBudgetMs) fail('timeout');
    base.metrics.logicalSearchCalls = 1;
    const result = await Promise.race([tool.execute({ objective: request.objective, search_queries: request.searchQueries, count: 5, session_id: request.sessionId }, { signal: controller.signal }), abortPromise]);
    controller.signal.throwIfAborted();
    if (performance.now() - started > request.remainingBudgetMs) fail('timeout');
    const { sources, rejected } = normalizeResult(result, now());
    base.sources = sources;
    base.metrics.searchMs = Math.round(performance.now() - started);
    // Transport posts are not measured at this boundary; keep them unknown.
    if (!sources.length) return { ...base, outcome: 'insufficient_sources', error: { code: 'insufficient_sources', stage: 'search', message: SAFE_MESSAGES.insufficient_sources, retryable: false, retryAfterMs: null } };
    const output = { ...base, outcome: rejected ? 'partial' : 'complete', error: rejected ? { code: 'sources_filtered', stage: 'validation', message: SAFE_MESSAGES.sources_filtered, retryable: false, retryAfterMs: null } : null };
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_OUTPUT_BYTES) fail('provider_response_too_large');
    return output;
  } catch (error) {
    const { code, retryAfterMs = null } = classify(error, abortedCode);
    base.metrics.searchMs = Math.round(performance.now() - started);
    return { ...base, outcome: code === 'cancelled' ? 'cancelled' : 'failed', error: { code, stage: base.metrics.logicalSearchCalls ? 'search' : 'admission', message: SAFE_MESSAGES[code] ?? SAFE_MESSAGES.provider_failed, retryable: ['timeout', 'rate_limited', 'provider_failed'].includes(code), retryAfterMs } };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

async function main() {
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) fail('invalid_request');
      chunks.push(chunk);
    }
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const result = await executeSearch(input, { signal: controller.signal });
    process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
  } catch {
    const result = await executeSearch(null);
    process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
