'use strict';
// Written for installer/termux-lite/test-session-open-plugin-tools.py (not an S24 capture).
// Runs the exact public OpenClaw 2026.10.9 function bodies that choose which plugins the
// per-run plugin tool registry loads (tools-DQdRObqo.mjs resolvePluginToolPluginIds and its
// deny helpers, with the real glob, allowlist, tool-name and manifest-availability bodies).
// Only the installed/enabled/control-plane predicates are inert (every plugin enabled and
// available, as on the S24 where both plugins load). No SDK import, plugin load, network,
// model, device or runtime mutation.
// Usage: node plugin-tool-selection-harness.cjs <dir holding the dist modules> <input.json>
// input.json: {"plugins": [manifest, ...], "cases": {"name": {"deny": [...], "allow": [...]|null}}}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const [dist, inputPath] = process.argv.slice(2);
assert(dist && inputPath, 'dist directory and input path required');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function source(file) {
  return fs.readFileSync(path.join(dist, file), 'utf8');
}
// Top-level declarations in these bundles start at column 0 and close with "}" or ");" at column 0.
function fn(file, name) {
  const text = source(file);
  const start = text.indexOf(`\nfunction ${name}(`);
  assert(start >= 0, `${file}: function ${name}`);
  const end = text.indexOf('\n}\n', start + 1);
  assert(end > start, `${file}: end of ${name}`);
  return text.slice(start + 1, end + 2);
}
function constant(file, name) {
  const text = source(file);
  const start = text.indexOf(`\nconst ${name} = `);
  assert(start >= 0, `${file}: const ${name}`);
  const end = text.indexOf(';\n', start + 1);
  assert(end > start, `${file}: end of ${name}`);
  return text.slice(start + 1, end + 2);
}

const bodies = [
  fn('string-coerce-1VuiLaaR.mjs', 'normalizeNullableString'),
  fn('string-coerce-1VuiLaaR.mjs', 'normalizeOptionalString'),
  fn('string-coerce-1VuiLaaR.mjs', 'normalizeOptionalLowercaseString'),
  fn('string-coerce-1VuiLaaR.mjs', 'normalizeLowercaseStringOrEmpty'),
  fn('string-normalization-D6DKCpwE.mjs', 'normalizeStringEntries'),
  fn('string-normalization-D6DKCpwE.mjs', 'uniqueValues'),
  fn('string-normalization-D6DKCpwE.mjs', 'uniqueStrings'),
  fn('string-normalization-D6DKCpwE.mjs', 'normalizeUniqueStringEntries'),
  fn('regexp-BZyMFTlj.mjs', 'escapeRegExp'),
  fn('glob-pattern-DuaaJ-nB.mjs', 'compileGlobPattern'),
  fn('glob-pattern-DuaaJ-nB.mjs', 'compileGlobPatterns'),
  fn('glob-pattern-DuaaJ-nB.mjs', 'matchesAnyGlobPattern'),
  constant('tool-policy-shared-CNWjndK7.mjs', 'TOOL_NAME_ALIASES'),
  fn('tool-policy-shared-CNWjndK7.mjs', 'normalizeToolPolicyName'),
  constant('tool-grant-allowlist-m1tXxJWt.mjs', 'RUNTIME_PLUGIN_TOOL_GRANT_PREFIX'),
  fn('tool-grant-allowlist-m1tXxJWt.mjs', 'runtimePluginToolGrantKey'),
  fn('tool-grant-allowlist-m1tXxJWt.mjs', 'createPluginToolAllowlist'),
  fn('manifest-tool-availability-DJlsKWK1.mjs', 'hasManifestToolAvailability'),
  fn('tools-DQdRObqo.mjs', 'normalizeDenylist'),
  fn('tools-DQdRObqo.mjs', 'denylistBlocksName'),
  fn('tools-DQdRObqo.mjs', 'denylistBlocksPlugin'),
  fn('tools-DQdRObqo.mjs', 'resolvePluginToolPluginIds'),
];

const inert = {
  // Signal checks run only for tools that declare toolMetadata; the captured manifests declare none.
  manifestConfigSignalPasses: () => { throw new Error('unexpected config signal check'); },
  manifestProviderBaseUrlGuardPasses: () => { throw new Error('unexpected provider guard check'); },
  hasNonEmptyManifestEnvCandidate: () => { throw new Error('unexpected env check'); },
  manifestPluginSetupProviderEnvVars: () => { throw new Error('unexpected env check'); },
  // Both plugins are installed, enabled and loaded on the S24 (gateway log fixture).
  normalizePluginsConfig: () => ({}),
  createInstalledPluginEnabledPredicate: () => () => true,
  isManifestPluginAvailableForControlPlane: () => true,
};
const sandbox = {Map, Set, RegExp, String, Array, Error, ...inert};
vm.createContext(sandbox);
vm.runInContext(bodies.join('\n'), sandbox, {filename: 'openclaw-2026.10.9-plugin-tool-selection.js'});

const snapshot = {index: {plugins: input.plugins}, plugins: input.plugins};
const selected = {};
for (const [name, policy] of Object.entries(input.cases)) {
  const allowlist = sandbox.createPluginToolAllowlist(policy.allow ?? undefined);
  selected[name] = sandbox.resolvePluginToolPluginIds({
    config: {}, env: {}, allowlist, toolDenylist: policy.deny ?? [], snapshot,
  });
}
process.stdout.write(JSON.stringify({selected}) + '\n');
