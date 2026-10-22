import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as miniflare from 'miniflare';
import { build } from 'esbuild';

// Synthetic identities exist only in this local Workerd fixture; no production
// token, grant, Google identity or Cloudflare account is accessed.
const resource = 'https://claw-voice-relay.claw-s24-voice-260930.workers.dev/mcp';
const compiled = await build({ stdin: { contents: "export {default, VoiceRelay} from './src/index.mjs';", resolveDir: process.cwd() }, bundle: true,
  write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const clients = Object.fromEntries(['claude-chat', 'codex-cloud'].map(id => [id, {
  tokenSha256: createHash('sha256').update('fixture-static-long-token-' + id).digest('hex'),
  profile: 'chat-owner', enabled: true,
}]));
const options = { workers: [{ name: 'relay', modules: true,
  script: compiled.outputFiles[0].text, compatibilityDate: '2026-10-21',
  serviceBindings: { CHATGPT_AUTH_SERVER: 'auth' },
  durableObjects: { VOICE_RELAY: { className: 'VoiceRelay', useSQLite: true } },
  bindings: { MCP_CLIENTS_JSON: JSON.stringify(clients) },
}, { name: 'auth', modules: true, compatibilityDate: '2026-10-21', script: `
  import { WorkerEntrypoint } from 'cloudflare:workers';
  export default class extends WorkerEntrypoint {
    validateToken(audience, token) {
      if (!['fixture-valid','fixture-wrong-scope','fixture-expired','fixture-wrong-audience'].includes(token)) return null;
      return { audience: token === 'fixture-wrong-audience' ? 'https://other.example/mcp' : audience,
        scope: token === 'fixture-wrong-scope' ? ['mcp:write'] : ['mcp:read'],
        expiresAt: Math.floor(Date.now()/1000) + (token === 'fixture-expired' ? -60 : 600),
        userId:'fixture-owner', props:{userId:'fixture-owner'} };
    }
    fetch() { return new Response('local fixture'); }
  }` }] };
const mf = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions
  ? miniflare.convertV4MiniflareOptions(options) : options);
async function list(token) {
  const response = await mf.dispatchFetch(resource, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/list', params:{} }) });
  const text = await response.text();
  return { status:response.status, body:text ? JSON.parse(text) : null };
}
try {
  for (const [token, expected] of [[null,401],['fixture-invalid',401],
    ['fixture-expired',401],['fixture-wrong-audience',401],['fixture-wrong-scope',403]]) {
    assert.equal((await list(token)).status, expected, String(token));
  }
  const oauth = await list('fixture-valid');
  assert.equal(oauth.status,200);
  assert.ok(oauth.body.result.tools.some(tool => tool.name === 'claw_context'));
  assert.ok(!oauth.body.result.tools.some(tool => tool.name === 'claw_exec'));
  for (const id of ['claude-chat','codex-cloud']) {
    const result = await list('fixture-static-long-token-' + id);
    assert.equal(result.status,200,id);
    assert.ok(result.body.result.tools.some(tool => tool.name === 'claw_exec'));
  }
  console.log('OAuth RPC + tools/list: PASS (8 cases; real local Workerd service binding)');
} finally { await mf.dispose(); }


