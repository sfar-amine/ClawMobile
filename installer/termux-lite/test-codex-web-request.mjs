// Codex hosted search adapter (Amine 04/11: app web questions through Codex alone).
// The Gateway response shape follows the pinned @openclaw/codex 2026.10.9 web_search provider
// (fixtures/openclaw-2026.10.9-compat/web-search-provider.runtime-DEBVJch2.mjs.gz) and core tools.invoke.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executeCodexWeb, projectAnswer, unwrapExternal, hostedSearchPayload, validateRequest } from './codex-web-request.mjs';

// Verbatim Gateway response captured on the S24 on 04/11 (18.7 s end to end, 13.3 s inside Codex).
const real = JSON.parse(fs.readFileSync(new URL('../../openclaw-plugin-mobile-ui/fixtures/codex-web/tools-invoke-web-search-20261104.json', import.meta.url), 'utf8'));

const request = { version: 1, operation: 'answer', query: 'prix du Brent aujourd’hui', responseLanguage: 'fr', remainingBudgetMs: 25000, sessionId: '6f1c2a0e-3b4d-5e6f-8a7b-9c0d1e2f3a4b' };
const wrap = text => `<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\nSource: Web Search\n---\n${text}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>`;
const answer = 'Le Brent cotait **103,50 $** le 3 novembre 2026 ([reuters.com](https://www.reuters.com/markets/oil?utm_source=openai)).\n\n- Le WTI était à 99,10 $ ([cnbc.com](https://www.cnbc.com/quotes/CL?utm_source=openai)).\n- Les deux ont reculé sur la semaine.\n\nSources :\n- [Reuters](https://www.reuters.com/markets/oil?utm_source=openai)';
const details = (text = answer, extra = {}) => ({ query: request.query, provider: 'codex', model: 'gpt-5.6-luna', tookMs: 14000,
  externalContent: { untrusted: true, source: 'web_search', provider: 'codex', wrapped: true }, content: wrap(text),
  searches: [{ query: 'Brent price today' }], ...extra });
const ok = payload => async () => ({ ok: true, toolName: 'web_search', output: { content: [{ type: 'text', text: JSON.stringify(payload) }], details: payload }, source: 'core' });

test('answer is projected into claims citing Codex links, no excerpt, no quote', async () => {
  const r = await executeCodexWeb(request, { call: ok(details()), now: () => '2026-11-04T09:00:00.000Z' });
  assert.equal(r.error, null);
  assert.equal(r.provider, 'codex'); assert.equal(r.providerAuth, 'account'); assert.equal(r.model, 'openai/gpt-5.6-luna');
  assert.deepEqual(r.sources.map(s => [s.id, s.url, s.excerpt, s.evidenceType]), [
    ['s1', 'https://www.reuters.com/markets/oil', '', 'codex_citation'], ['s2', 'https://www.cnbc.com/quotes/CL', '', 'codex_citation']]);
  assert.deepEqual(r.claims.map(c => [c.text, c.sourceIds]), [
    ['Le Brent cotait 103,50 $ le 3 novembre 2026.', ['s1']], ['Le WTI était à 99,10 $.', ['s2']], ['Les deux ont reculé sur la semaine.', ['s1', 's2']]]);
  assert.equal(r.metrics.logicalSearchCalls, 1); assert.equal(r.metrics.cacheHit, false);
  assert(r.claims.every(c => !('support' in c) && !/https?:|\]\(|[<>*]/u.test(c.text)));
});

test('real S24 capture: one claim citing both links, trailing citations out of the text, hosted-search profile', async () => {
  assert.equal(real.provenance.device, 'S24');
  const r = await executeCodexWeb({ ...request, query: 'prix du Brent aujourd hui' }, { call: async () => real.response, now: () => '2026-11-04T09:19:00.000Z' });
  assert.equal(r.error, null);
  assert.equal(r.model, 'openai/codex-hosted-search');
  assert.deepEqual(r.sources.map(s => [s.id, s.title, s.url]), [['s1', 'NowPrice', 'https://nowprice.io/fr/carburant/brent-crude'], ['s2', 'CoursPétrole', 'https://courspetrole.com/brent/']]);
  assert.deepEqual(r.claims, [{ id: 'c1', text: 'Aujourd’hui, le Brent cote environ 103,90 $ le baril (soit environ 92,94 €), cours indicatif mis à jour le 4 novembre 2026. Les cotations peuvent varier en temps réel.', sourceIds: ['s1', 's2'] }]);
});

test('the Gateway call is one web_search under the contacts tool policy (main denies web_search) within the budget', async () => {
  const calls = [];
  await executeCodexWeb(request, { call: async (params, budget) => { calls.push([params, budget]); return ok(details())(); } });
  assert.deepEqual(calls, [[{ name: 'web_search', args: { query: request.query }, agentId: 'contacts' }, 25000]]);
});

test('payload is read from details or from the JSON text content', () => {
  assert.equal(hostedSearchPayload({ details: details() }).provider, 'codex');
  assert.equal(hostedSearchPayload({ content: [{ type: 'text', text: JSON.stringify(details()) }] }).provider, 'codex');
  assert.throws(() => hostedSearchPayload({ details: { ...details(), provider: 'parallel-free' } }));
  assert.equal(unwrapExternal(wrap('a\nb')), 'a\nb');
});

test('no search, refusals and transport failures are named, never an invented answer', async () => {
  const cases = [
    [ok(details(answer, { kind: 'results' })), 'provider_contract'],
    [async () => ({ ok: false, toolName: 'web_search', error: { code: 'internal_error', message: 'Codex hosted search completed without invoking web search.' } }), 'no_web_search'],
    [async () => ({ ok: false, toolName: 'web_search', error: { code: 'forbidden', message: 'blocked' } }), 'access_denied'],
    [async () => ({ ok: false, toolName: 'web_search', error: { code: 'internal_error', message: 'boom' } }), 'provider_unavailable'],
    [ok(details(answer, { model: 'Paid Model!' })), 'provider_contract'],
    [ok({ ...details(), provider: 'brave' }), 'provider_contract'],
    [async () => { const e = new Error('x'); throw e; }, 'provider_unavailable'],
  ];
  for (const [call, code] of cases) {
    const r = await executeCodexWeb(request, { call });
    assert.equal(r.error.code, code, code); assert.deepEqual(r.sources, []); assert.deepEqual(r.claims, []);
  }
});

test('requests outside the closed contract start nothing', async () => {
  let called = false;
  const call = async () => { called = true; return ok(details())(); };
  for (const bad of [{ ...request, remainingBudgetMs: 30001 }, { ...request, operation: 'fetch' }, { ...request, query: '' }, { ...request, extra: 1 }, { ...request, responseLanguage: 'de' }, null]) {
    const r = await executeCodexWeb(bad, { call });
    assert.equal(r.error.code, 'invalid_request');
  }
  assert.equal(called, false);
  assert.throws(() => validateRequest({ ...request, sessionId: 'not-a-uuid' }));
});

test('unsafe links are dropped, sources capped at five, long paragraphs split, totals bounded', () => {
  const links = Array.from({ length: 7 }, (_, i) => `[site${i}](https://site${i}.example.org/a)`).join(' ');
  const r = projectAnswer(`Fait public ${links}.\n\nLien local [x](http://127.0.0.1/a) seulement.\n\n${'Phrase longue. '.repeat(120)}`, '2026-11-04T09:00:00Z');
  assert.equal(r.sources.length, 5);
  assert(r.sources.every(s => !s.url.includes('127.0.0.1')));
  assert(r.claims.every(c => c.text.length <= 1000 && c.sourceIds.length >= 1 && c.sourceIds.length <= 5));
  assert(r.claims.reduce((n, c) => n + c.text.length, 0) <= 4000);
  assert.deepEqual(projectAnswer('Aucune source citée ici.', 'x'), { sources: [], claims: [] });
});

test('a hung Gateway call is killed at the deadline and leaves no process behind', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'codex-web-'));
  const pidFile = join(dir, 'pid');
  const bin = join(dir, 'openclaw');
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`); chmodSync(bin, 0o755);
  process.env.CLAWMOBILE_OPENCLAW_BIN = bin;
  try {
    const started = Date.now();
    const r = await executeCodexWeb({ ...request, remainingBudgetMs: 1500 });
    assert.equal(r.error.code, 'deadline_exceeded');
    assert(Date.now() - started < 4000);
    await new Promise(done => setTimeout(done, 200));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert(existsSync(pidFile));
    assert.throws(() => process.kill(pid, 0));
  } finally { delete process.env.CLAWMOBILE_OPENCLAW_BIN; }
});
