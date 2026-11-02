// #126: inside the Gateway the model profile hooks use the host's own session API (api.runtime) and never load the
// installed OpenClaw SDK surface, whose file-URL import made OpenClaw copy 21 045 files / 190 MB into the plugin
// capture at each restart (S24 01/11). The Companion process (no api) keeps the loader. Authored fixtures only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-profile-host-session-"));
  process.env.OPENCLAW_STATE_DIR = root;
  await fs.mkdir(path.join(root, "clawmobile-companion"));
  await fs.writeFile(path.join(root, "clawmobile-companion/runs.json"),
    JSON.stringify({version: 1, runs: [], archivedSessionIds: [], paymentRequests: [], ownerConfirmations: []}));
  const runs = require("../dist/companion/runs");
  runs.readModelFlowConfigurationActivity = async () => [];
  const profile = require("../dist/companion/conversationModelProfile");
  const {readChunkConstExport} = require("../dist/companion/openclawSdkVersions");

  // 1. No host API (Companion, older OpenClaw): undefined, so the installed loader stays in use.
  assert.equal(profile.hostSessionStoreSdk(undefined), undefined);
  assert.equal(profile.hostSessionStoreSdk({runtime: {}}), undefined);
  const calls = [];
  const session = {
    getSessionEntry: p => { calls.push(["get", p]); return {sessionId: "session-authored"}; },
    listSessionEntries: p => { calls.push(["list", p]); return []; },
    patchSessionEntry: async p => { calls.push(["patch", p]); return null; },
  };
  const config = {current: () => { calls.push(["config"]); return {agents: {entries: {main: {}}}}; }};
  for (const missing of ["getSessionEntry", "listSessionEntries", "patchSessionEntry"]) {
    const partial = {...session}; delete partial[missing];
    assert.equal(profile.hostSessionStoreSdk({runtime: {agent: {session: partial}, config}}), undefined, missing);
  }
  assert.equal(profile.hostSessionStoreSdk({runtime: {agent: {session}, config: {}}}), undefined, "config.current required");

  // 2. Host API present: exact delegation, same parameters, contract version injected.
  const load = profile.hostSessionStoreSdk({runtime: {agent: {session}, config}}, async () => 1);
  assert.equal(typeof load, "function");
  const sdk = await load();
  assert.equal(sdk.modelProfileContractVersion, 1);
  const read = {agentId: "main", sessionKey: "agent:main:companion-x", readConsistency: "latest"};
  assert.deepEqual(sdk.getSessionEntry(read), {sessionId: "session-authored"});
  assert.deepEqual(sdk.listSessionEntries({agentId: "main", readOnly: true}), []);
  assert.equal(await sdk.patchSessionEntry({...read, update: () => null}), null);
  assert.deepEqual(sdk.getRuntimeConfig(), {agents: {entries: {main: {}}}});
  assert.deepEqual(calls.map(c => c[0]), ["get", "list", "patch", "config"]);
  assert.strictEqual(calls[0][1], read, "parameters are passed through unchanged");

  // 3. Hooks built with the host API never call the installed SDK loader (the import that fed the capture).
  let loaderCalls = 0;
  profile.setConversationModelProfileSdkForTests(async () => { loaderCalls++; throw new Error("installed_sdk_loaded"); });
  profile.setModelProfileContractReaderForTests(async () => 1);
  calls.length = 0;
  const contexts = new Map();
  const hooks = profile.conversationModelProfileHooks({
    runtime: {agent: {session}, config},
    runContext: {getRunContext: ({runId, namespace}) => contexts.get(runId + namespace),
      setRunContext: ({runId, namespace, value}) => { contexts.set(runId + namespace, value); return true; }},
  });
  const ctx = {runId: "authored-run", sessionKey: "agent:main:companion-x", sessionId: "session-authored", agentId: "main"};
  await hooks.resolve({modelProfileVersion: 1, modelProfileStage: "before_candidates"}, ctx);
  await hooks.admit({}, ctx);
  assert.equal(loaderCalls, 0, "the installed SDK surface is never imported inside the Gateway");
  assert.ok(calls.some(c => c[0] === "config"), "the host runtime config was read");

  // Without the host API the same hooks still use the loader (Companion / older host): unchanged behaviour.
  const legacy = profile.conversationModelProfileHooks({runContext: {getRunContext: () => undefined, setRunContext: () => true}});
  assert.deepEqual(await legacy.resolve({modelProfileVersion: 1, modelProfileStage: "before_candidates"}, ctx),
    {modelSelectionRefused: "model_profile_unavailable"});
  assert.equal(loaderCalls, 1);

  // 4. The contract version is read as text from the hashed chunk, never imported.
  assert.equal(readChunkConstExport("export const MODEL_PROFILE_CONTRACT_VERSION = 1;\n", "MODEL_PROFILE_CONTRACT_VERSION"), 1);
  assert.equal(readChunkConstExport("const MODEL_PROFILE_CONTRACT_VERSION = 1;\nexport { a, MODEL_PROFILE_CONTRACT_VERSION };\n",
    "MODEL_PROFILE_CONTRACT_VERSION"), 1, "2026.10.9 export clause");
  assert.equal(readChunkConstExport("const MODEL_PROFILE_CONTRACT_VERSION = 1;\nexport { MODEL_PROFILE_CONTRACT_VERSION as X };\n",
    "MODEL_PROFILE_CONTRACT_VERSION"), 0, "aliased export refused");
  assert.equal(readChunkConstExport("const MODEL_PROFILE_CONTRACT_VERSION = 1;\n", "MODEL_PROFILE_CONTRACT_VERSION"), 0, "not exported");
  assert.equal(readChunkConstExport("export const MODEL_PROFILE_CONTRACT_VERSION = 1;\nexport const MODEL_PROFILE_CONTRACT_VERSION = 2;\n",
    "MODEL_PROFILE_CONTRACT_VERSION"), 0, "duplicate declaration refused");
  assert.equal(readChunkConstExport("export const A = 1;\n", "A;process.exit()"), 0, "symbol is validated");
  await fs.rm(root, {recursive: true, force: true});
  console.log("model profile host session: ok");
})().catch(error => { console.error(error); process.exit(1); });
