/** Real published SDK + official plugin fixture outside node_modules. Only HTTP
 * responses and DNS are simulated, with socket connections denied in the child. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = await fs.realpath(process.argv[2]);
assert.equal(JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'))).version, '2026.9.6');
const fixtures = path.resolve(HERE, '../../openclaw-plugin-mobile-ui/fixtures/parallel-free');
const pin = JSON.parse(await fs.readFile(path.join(HERE, 'openclaw-compat/parallel-free/pin.json')));
const archive = path.join(fixtures, 'parallel-plugin-2026.9.6.tgz');
assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'), pin.tarballSha256);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-real-sdk-'));
const proofs = [];
try {
  for (const mode of ['official-outside-node-modules', 'partial-local-sdk']) {
    const work = path.join(root, mode);
    await fs.mkdir(work);
    execFileSync('python3', ['-c', 'import tarfile,sys;t=tarfile.open(sys.argv[1]);t.extractall(sys.argv[2],filter="data")', archive, work]);
    const pluginRoot = path.join(work, 'package');
    execFileSync('python3', [path.join(HERE, 'openclaw-compat/parallel-free/patch-provider.py'), '--plugin-dir', pluginRoot, '--apply']);
    if (mode === 'partial-local-sdk') {
      const partial = path.join(pluginRoot, 'node_modules/openclaw');
      await fs.mkdir(partial, { recursive: true });
      await fs.writeFile(path.join(partial, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.6', exports: { './plugin-sdk/provider-web-search': './missing.js' } }));
    }
    const config = path.join(work, 'openclaw.json');
    await fs.writeFile(config, JSON.stringify({ tools: { web: { search: { enabled: true } } } }));
    const env = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', HOME: path.join(work, 'home'), OPENCLAW_STATE_DIR: path.join(work, 'state'), OPENCLAW_CONFIG_PATH: config, CLAW_WEB_PARALLEL_PLUGIN_DIR: pluginRoot, CLAWMOBILE_OPENCLAW_BIN: path.join(sdkRoot, 'openclaw.mjs') };
    const child = execFileSync(process.execPath, [path.join(fixtures, 'real-sdk-offline-worker.mjs'), path.join(HERE, 'openclaw-web-request.mjs')], { env, encoding: 'utf8', timeout: 20000 });
    const proof = JSON.parse(child);
    assert.equal(proof.forbiddenConnections, 0);
    assert.equal(proof.sdkSimulated, false);
    assert.equal(proof.unrelatedSpecifierStillUnresolved, true, 'resolver must not expose SDK to unrelated importers');
    if (mode === 'official-outside-node-modules') {
      assert.equal(proof.result.outcome, 'complete', JSON.stringify(proof.result));
      assert.equal(proof.result.sources[0].title, 'Official public fixture');
      assert.equal(proof.result.sources[0].excerpt, 'Public SDK contract fixture.');
      assert.equal(proof.result.metrics.cacheHit, false);
      assert.deepEqual(proof.calls.map(call => call.method), ['initialize', 'notifications/initialized', 'tools/call']);
    } else {
      assert.equal(proof.result.error.code, 'provider_integrity');
      assert.equal(proof.result.metrics.logicalSearchCalls, 0);
      assert.deepEqual(proof.calls, []);
    }
    proofs.push({ mode, ...proof });
  }
  console.log(JSON.stringify({ suite: 'real-pinned-sdk-native-plugin', cloudOnly: true, credentialsInherited: false, passed: 2, total: 2, proofs }));
} finally { await fs.rm(root, { recursive: true, force: true }); }
