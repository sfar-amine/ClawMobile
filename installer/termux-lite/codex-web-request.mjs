#!/usr/bin/env node
/** App web answer through Codex hosted search (Amine 04/11: Codex alone, no Parallel, no Gemini, no fallback).
 * One Gateway `tools.invoke web_search` call: the Gateway's configured provider (codex, Sol's own OpenAI
 * account) searches and writes the answer. This adapter only projects that answer into the closed public Web
 * contract: plain claims, the links Codex cited, no page excerpt (Codex returns none), no cache, no retry.
 * stdin: {version:1, operation, query, responseLanguage, remainingBudgetMs, sessionId}; stdout: one JSON line.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { publicSourceUrl } from './openclaw-web-request.mjs';

const MAX_INPUT_BYTES = 16384;
const MAX_OUTPUT_BYTES = 65536;
const MAX_BUDGET_MS = 30000;
const MAX_SOURCES = 5;
const MAX_CLAIMS = 12;
const MAX_CLAIM_CHARS = 1000;
const MAX_ANSWER_CHARS = 4000;
const PROVIDER = 'codex';
// The main agent's tool policy denies web_search (route web unique, 04/11): its brain reaches the web only through
// this adapter. tools.invoke applies the named agent's policy, so the call runs under the contacts agent, whose
// policy allows exactly web_search (verified on the S24 04/11: tools.invoke agentId contacts → provider codex, 17.8 s).
const WEB_TOOL_AGENT = 'contacts';

class CodexWebError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new CodexWebError(code); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateRequest(value) {
  if (!isObject(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_INPUT_BYTES) fail('invalid_request');
  const allowed = new Set(['version', 'operation', 'query', 'responseLanguage', 'remainingBudgetMs', 'sessionId']);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.version !== 1 || !['search', 'answer'].includes(value.operation)) fail('invalid_request');
  if (typeof value.query !== 'string' || !value.query.trim() || Array.from(value.query).length > 1000 || /[\u0000-\u001f\u007f]/u.test(value.query)) fail('invalid_request');
  if (!['fr', 'en', 'ar', 'aeb'].includes(value.responseLanguage)) fail('invalid_request');
  if (!Number.isInteger(value.remainingBudgetMs) || value.remainingBudgetMs < 1 || value.remainingBudgetMs > MAX_BUDGET_MS) fail('invalid_request');
  if (typeof value.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sessionId)) fail('invalid_request');
  return Object.freeze({ ...value, query: value.query.trim() });
}

/** The Gateway wraps hosted-search text as untrusted external content; only the boundary syntax is removed. */
export function unwrapExternal(value) {
  if (typeof value !== 'string') fail('provider_contract');
  const match = /^\s*<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\n(?:Source: [^\n]*\n---\n)?([\s\S]*?)\n?<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>\s*$/u.exec(value);
  return match ? match[2] : value;
}

/** tools.invoke returns the tool result; the web_search payload is its details, or the JSON text content. */
export function hostedSearchPayload(output) {
  if (isObject(output?.details) && output.details.provider === PROVIDER) return output.details;
  if (isObject(output) && output.provider === PROVIDER) return output;
  const text = Array.isArray(output?.content) ? output.content.find(part => part?.type === 'text')?.text : undefined;
  if (typeof text === 'string') {
    try { const parsed = JSON.parse(text); if (isObject(parsed) && parsed.provider === PROVIDER) return parsed; } catch {}
  }
  fail('provider_contract');
}

function cleanUrl(raw) {
  const url = publicSourceUrl(raw.replace(/[).,;:!?»”'"]+$/u, ''));
  if (!url) return null;
  const parsed = new URL(url);
  parsed.searchParams.delete('utm_source');  // Codex tags every cited link with utm_source=openai.
  return parsed.href;
}
function hostTitle(url) { return new URL(url).hostname.replace(/^www\./u, ''); }
// A run of cited links closing a paragraph ("… réel. [NowPrice](…) · [CoursPétrole](…)", S24 04/11) is a
// citation, not words of the answer.
const TRAILING_CITATIONS = /(?:\s*[·•|,;–-]?\s*\(?\[[^\]]*\]\([^)\s]+\)\)?)+\s*([.!?]?)\s*$/u;
function plain(text) {
  return text
    .replace(TRAILING_CITATIONS, '$1')
    .replace(/\(\s*\[[^\]]*\]\([^)]*\)\s*\)/gu, '')        // ([site](url)) inline citation
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')               // [label](url) -> label
    .replace(/https?:\/\/\S+/gu, '')                        // bare links
    .replace(/[*_`#]+/gu, '')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/u, '')
    .replace(/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/gu, '')
    .replace(/\(\s*\)/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s+([.,;:!?])/gu, '$1')
    .trim();
}
function splitLong(text) {
  if (text.length <= MAX_CLAIM_CHARS) return [text];
  const parts = []; let current = '';
  for (const sentence of text.split(/(?<=[.!?…])\s+/u)) {
    if (current && (current + ' ' + sentence).length > MAX_CLAIM_CHARS) { parts.push(current); current = ''; }
    current = current ? current + ' ' + sentence : sentence;
  }
  if (current) parts.push(current);
  return parts.map(part => part.slice(0, MAX_CLAIM_CHARS));
}

/** Claims are the answer's paragraphs and list items. A block citing links cites those; a block without an
 * inline link cites the answer's own source list (Codex grounds the whole answer on it). A trailing
 * "Sources" list only provides sources. Nothing is added that Codex did not write. */
export function projectAnswer(answerText, retrievedAt) {
  const sources = []; const byUrl = new Map();
  const addSource = (rawUrl, label) => {
    const url = cleanUrl(rawUrl);
    if (!url) return null;
    if (byUrl.has(url)) return byUrl.get(url);
    if (sources.length >= MAX_SOURCES) return null;
    const title = plain(label || '').slice(0, 300) || hostTitle(url);
    const source = { id: `s${sources.length + 1}`, title, url, searchRetrievedAt: retrievedAt, publishedAt: null, excerpt: '', evidenceType: 'codex_citation' };
    sources.push(source); byUrl.set(url, source.id);
    return source.id;
  };
  const blocks = [];
  for (const block of answerText.replace(/\r/gu, '').split(/\n\s*\n/u)) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    const bulleted = lines.length > 1 && lines.every(line => /^(?:[-•*]|\d+[.)])\s+/u.test(line) || /:\s*$/u.test(line));
    for (const piece of bulleted ? lines : [lines.join(' ')]) if (piece) blocks.push(piece);
  }
  const drafts = [];
  for (const block of blocks) {
    const refs = [];
    for (const match of block.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)\]]+)/gu)) {
      const id = addSource(match[2] || match[3], match[1] || '');
      if (id && !refs.includes(id)) refs.push(id);
    }
    const text = plain(block);
    if (/^(?:sources?|références?|references|المصادر)\s*:?$/iu.test(text)) continue;
    // A line that is only links (a source list item) carries no statement.
    const statement = plain(block.replace(/\[[^\]]*\]\([^)]*\)/gu, '').replace(/https?:\/\/\S+/gu, ''));
    if (!text || text.length < 3 || !statement.replace(/[\s:.,;()–—-]/gu, '')) continue;
    drafts.push({ text, refs });
  }
  const claims = []; let chars = 0;
  for (const draft of drafts) {
    const ids = (draft.refs.length ? draft.refs : sources.map(source => source.id)).slice(0, MAX_SOURCES);
    if (!ids.length) continue;
    for (const text of splitLong(draft.text)) {
      if (claims.length >= MAX_CLAIMS || chars + text.length > MAX_ANSWER_CHARS) break;
      chars += text.length;
      claims.push({ id: `c${claims.length + 1}`, text, sourceIds: ids });
    }
  }
  return { sources, claims };
}

function gatewayCall(params, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const bin = process.env.CLAWMOBILE_OPENCLAW_BIN || 'openclaw';
    const child = spawn(bin, ['gateway', 'call', 'tools.invoke', '--json', '--timeout', String(Math.max(1000, timeoutMs - 500)), '--params', JSON.stringify(params)],
      // Same process group as this adapter: public_web.py ends a run by killing that group, so the Gateway call
      // can never outlive its deadline as an orphan.
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const kill = () => { try { child.kill('SIGKILL'); } catch {} };
    const abort = () => { kill(); finish(new CodexWebError('cancelled')); };
    const timer = setTimeout(() => { kill(); finish(new CodexWebError('deadline_exceeded')); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 4 * MAX_OUTPUT_BYTES) { kill(); finish(new CodexWebError('provider_response_too_large')); } });
    child.on('error', () => finish(new CodexWebError('gateway_unavailable')));
    child.on('close', code => {
      if (code !== 0) return finish(new CodexWebError('gateway_unavailable'));
      for (const candidate of [out.trim(), ...out.trim().split('\n').reverse()]) {
        try { return finish(null, JSON.parse(candidate)); } catch {}
      }
      finish(new CodexWebError('provider_contract'));
    });
  });
}

const INVOKE_ERRORS = { forbidden: 'access_denied', not_found: 'no_web_search', validation_error: 'invalid_request', requires_approval: 'access_denied' };

export async function executeCodexWeb(input, { call = gatewayCall, signal, now = () => new Date().toISOString() } = {}) {
  const started = performance.now();
  const base = { version: 1, provider: PROVIDER, providerAuth: 'account', model: null, sources: [], claims: [],
    metrics: { searchMs: null, logicalSearchCalls: 0, cacheHit: false }, error: null };
  try {
    const request = validateRequest(input);
    base.metrics.logicalSearchCalls = 1;
    const response = await call({ name: 'web_search', args: { query: request.query }, agentId: WEB_TOOL_AGENT }, request.remainingBudgetMs, signal);
    if (!isObject(response)) fail('provider_contract');
    if (response.ok !== true) {
      const code = response.error?.code;
      const message = String(response.error?.message || '');
      fail(/without invoking web search/u.test(message) ? 'no_web_search' : INVOKE_ERRORS[code] || 'provider_unavailable');
    }
    const payload = hostedSearchPayload(response.output);
    // The Gateway's web_search tool returns {kind, provider, query, tookMs, content, externalContent} (S24 04/11):
    // the Codex provider itself fails when no hosted search ran, and the model it used is not reported, so the
    // run names the hosted-search profile unless a model is given.
    if (payload.kind !== undefined && payload.kind !== 'answer') fail('provider_contract');
    const modelId = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim().toLowerCase() : 'codex-hosted-search';
    const model = modelId.includes('/') ? modelId : 'openai/' + modelId;
    if (!/^openai\/[a-z0-9][a-z0-9.-]{0,60}$/u.test(model)) fail('provider_contract');
    const { sources, claims } = projectAnswer(unwrapExternal(payload.content), now());
    base.model = model; base.sources = sources; base.claims = claims;
    base.metrics.searchMs = Math.round(performance.now() - started);
    if (Buffer.byteLength(JSON.stringify(base), 'utf8') > MAX_OUTPUT_BYTES) fail('provider_response_too_large');
    return base;
  } catch (error) {
    base.metrics.searchMs = Math.round(performance.now() - started);
    base.sources = []; base.claims = [];
    return { ...base, error: { code: error instanceof CodexWebError ? error.code : 'provider_unavailable' } };
  }
}

async function main() {
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  let size = 0; const chunks = []; let input = null;
  try {
    for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_INPUT_BYTES) break; chunks.push(chunk); }
    if (size <= MAX_INPUT_BYTES) input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {}
  const result = await executeCodexWeb(input, { signal: controller.signal });
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
