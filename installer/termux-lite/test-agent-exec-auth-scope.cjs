// Execute the captured native snapshot producer, with synthetic stores only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const root = path.join(__dirname, '../../openclaw-plugin-mobile-ui/fixtures/s24-2026-10-23-native-auth-scope');
const original = fs.readFileSync(path.join(root, 'runtime-BnnQBrxr.mjs'), 'utf8');
const manifest = require('./openclaw-compat/agent-exec-auth-scope.json');
let patched = original;
for (const [before, after] of manifest.files[0].replacements) {
  assert.equal(patched.split(before).length, 2);
  patched = patched.replace(before, after);
}
function capturedFunction(source, name, end) {
  const start = source.indexOf(name);
  assert(start >= 0);
  return source.slice(start, source.indexOf(end, start));
}
function harness(source, states) {
  const scoped = new AsyncLocalStorage();
  const ambient = { OPENCLAW_STATE_DIR: '/synthetic/isolated-execution' };
  const store = () => ({ version: 1, profiles: { synthetic: { type: 'api_key', keyRef: { source: 'store', id: 'PUBLIC_FIXTURE' } } } });
  const context = {
    structuredClone, getScopedAuthProfileEnv: () => scoped.getStore(),
    mergeSecretsRuntimeEnv: env => ({ ...ambient, ...env }),
    getRuntimeAuthProfileStoreCredentialsRevision: () => 1,
    getRuntimeAuthProfileStoreSnapshotsRevision: () => 1,
    cloneConfigWithResolutionFacts: structuredClone,
    loadAuthProfileStoreWithoutExternalProfiles: store,
    loadAuthProfileStoreForSecretsRuntime: store,
    collectCandidateAgentDirs: () => ['/synthetic/agent'], uniqueStrings: v => [...new Set(v)],
    resolveUserPath: v => v, resolveAuthProfileDatabasePath: v => v + '/public.sqlite',
    resolveAuthProfileDatabaseOwnerId: v => v, readAgentDatabaseAdmissionRefusal: () => null,
    canUseSecretsRuntimeFastPath: () => false,
    shouldLoadPluginMetadataForSecrets: () => false,
    secretRefKey: ref => ref.id,
    copyConfigResolutionFactsExcept: () => {},
    createEmptyRuntimeWebToolsMetadata: () => ({}),
    prepareRuntimeAuthProfileStoreSnapshots: (entries, env) => entries.map(e => ({ ...e, ownerEnv: env })),
    setPreparedSecretsRuntimeSnapshotRefreshContext: (snapshot, refresh) => { snapshot.observedRefresh = refresh; },
    loadRuntimePrepareHelpers: async () => ({
      createResolverContext: params => ({ ...params, assignments: [], warnings: [], cache: {} }),
      collectAuthStoreAssignments: ({ store, context }) => context.assignments.push({
        ref: store.profiles.synthetic.keyRef, path: 'auth.synthetic',
        apply: value => { store.profiles.synthetic.key = value; },
      }),
      collectConfigAssignments: () => { throw new Error('unexpected config secret access'); },
    }),
    loadRuntimeOwnerAssignmentHelpers: async () => ({
      listSecretAssignmentOwners: () => [],
      resolveAndApplySecretAssignments: async ({ context, assignments }) => {
        await new Promise(resolve => setImmediate(resolve));
        const value = states[context.env.OPENCLAW_STATE_DIR];
        if (!value) throw new Error('SYNTHETIC_SECRET_ENTRY_NOT_FOUND');
        for (const assignment of assignments) assignment.apply(value);
        return { degradedOwners: [], resolvedValues: new Map([['PUBLIC_FIXTURE', value]]) };
      },
    }),
  };
  vm.createContext(context);
  vm.runInContext(
    capturedFunction(source, 'function loadAdmittedAuthStores', '//#endregion') + '\n' +
    capturedFunction(source, 'async function prepareSecretsRuntimeSnapshot', '/** Activates a prepared secrets runtime snapshot'), context);
  return { scoped, ambient, run: env => context.prepareSecretsRuntimeSnapshot({ config: {}, includeConfigRefs: false, ...(env === undefined ? {} : { env }) }) };
}
(async () => {
  const states = { '/synthetic/native': 'PUBLIC_NATIVE_SENTINEL', '/synthetic/override': 'PUBLIC_OVERRIDE_SENTINEL' };
  const old = harness(original, states);
  await assert.rejects(old.scoped.run({ OPENCLAW_STATE_DIR: '/synthetic/native' }, () => old.run()), /SYNTHETIC_SECRET_ENTRY_NOT_FOUND/);
  const fixed = harness(patched, states);
  const result = await fixed.scoped.run({ OPENCLAW_STATE_DIR: '/synthetic/native' }, () => fixed.run());
  assert.equal(result.authStores[0].store.profiles.synthetic.key, 'PUBLIC_NATIVE_SENTINEL');
  assert.equal(result.observedRefresh.env.OPENCLAW_STATE_DIR, '/synthetic/native');
  assert.equal(fixed.ambient.OPENCLAW_STATE_DIR, '/synthetic/isolated-execution');
  const explicit = await fixed.scoped.run({ OPENCLAW_STATE_DIR: '/synthetic/native' }, () => fixed.run({ OPENCLAW_STATE_DIR: '/synthetic/override' }));
  assert.equal(explicit.authStores[0].store.profiles.synthetic.key, 'PUBLIC_OVERRIDE_SENTINEL');
  const missing = harness(patched, {});
  await assert.rejects(missing.scoped.run({ OPENCLAW_STATE_DIR: '/synthetic/native' }, () => missing.run()), /SYNTHETIC_SECRET_ENTRY_NOT_FOUND/);
  const normal = harness(patched, { '/synthetic/isolated-execution': 'PUBLIC_NORMAL_SENTINEL' });
  assert.equal((await normal.run()).authStores[0].store.profiles.synthetic.key, 'PUBLIC_NORMAL_SENTINEL');
  const parallel = await Promise.all(Object.keys(states).map(state => fixed.scoped.run({ OPENCLAW_STATE_DIR: state }, () => fixed.run())));
  assert.deepEqual(parallel.map(r => r.authStores[0].store.profiles.synthetic.key), Object.values(states));
  console.log('PASS: captured native pre-patch failure; scoped auth, explicit override, isolated runtime, missing-secret refusal, ordinary and concurrent scopes');
})().catch(error => { console.error(error); process.exitCode = 1; });
