// #126 (S24 01/11): the Gateway copies every declared plugin dependency file by file on its main thread at the first
// owner turn after a restart. Keep the declared set to what the plugin needs at turn time; Nostr loads on use.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {pathToFileURL} = require("url");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const measured = JSON.parse(fs.readFileSync(path.join(root, "fixtures/s24-2026-11-01-plugin-capture/measurements.json"), "utf8"));

// 1. Only ws is captured at turn time (19 files on the S24) instead of 635.
const captured = [...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.optionalDependencies || {}),
  ...Object.keys(manifest.peerDependencies || {})];
assert.deepStrictEqual(captured, ["ws"], "declared (captured) dependencies grew: " + captured.join(", "));
assert.ok(manifest.devDependencies["nostr-tools"], "nostr-tools stays installed through npm install --include=dev");
const files = measured.declared_dependency_files;
const before = Object.values(files).reduce((a, b) => a + b, 0);
assert.strictEqual(before, 635);
assert.strictEqual(captured.reduce((n, name) => n + files[name], 0), 19);

// 2. No built module names nostr-tools as a literal require (the Gateway's source-reference scan would capture it).
const dist = path.join(root, "dist");
const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
for (const file of walk(dist))
  assert.ok(!/require\(["']nostr-tools["']\)|from ["']nostr-tools["']/.test(fs.readFileSync(file, "utf8")),
    path.relative(root, file) + " requires nostr-tools literally");

// 3. Loading the Nostr module does not load nostr-tools; the first Nostr call does, and still works.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawmobile-nostr-lazy-"));
process.env.CLAWMOBILE_NOSTR_CONFIG = path.join(tmp, "nostr.json");
const loaded = () => Object.keys(require.cache).some((id) => id.includes(`${path.sep}nostr-tools${path.sep}`));
const nostr = require(path.join(dist, "companion/nostr.js"));
assert.strictEqual(loaded(), false, "nostr-tools loaded with the module");
const identity = nostr.setupNostrIdentity({relays: ["wss://relay.example.com"]});
assert.match(identity.npub, /^npub1/);
assert.strictEqual(loaded(), true);
fs.rmSync(tmp, {recursive: true, force: true});

// 4-6. After #498 (S24 01/11 18:25, fixtures/s24-2026-11-01-plugin-capture/capture-after-498.json) the first owner turn
// still spent 41.9 s capturing: the model profile hook imported the session store surface and the contract chunk by
// file URL, so OpenClaw copied 21 045 host files (192 packages, 190 MB) into the plugin capture. The capture rule
// (OpenClaw 2026.9.6 and 2026.10.9, npm sources pinned in that fixture): a file: or absolute specifier imported from
// a captured plugin module and resolving outside the plugin is captured with its package graph; a bare `openclaw/...`
// specifier goes to native resolution through the capture's node_modules/openclaw link to the live host.
const after = JSON.parse(fs.readFileSync(path.join(root, "fixtures/s24-2026-11-01-plugin-capture/capture-after-498.json"), "utf8"));
assert.strictEqual(after.mobile_ui_session_store_capture.host_attributable.files, 21045);
for (const version of ["2026.9.6", "2026.10.9"]) {
  const rule = after.openclaw_rule[version].native_or_capture;
  assert.ok(rule.startsWith('if (!(specifier.startsWith("file:") || path.isAbsolute(specifier)) || !native.url.startsWith("file:")'), version);
  assert.strictEqual(after.openclaw_rule[version].host_name_skipped, 'if (name === "openclaw" || name === "@openclaw/plugin-sdk") return;');
}
const {modelFlowSdk} = require("../../installer/termux-lite/model-flow-sdk-fixtures.cjs");
const {readChunkConstExport} = require(path.join(dist, "companion/openclawSdkVersions.js"));
const SYMBOL = "MODEL_PROFILE_CONTRACT_VERSION";
const surface = JSON.parse(fs.readFileSync(path.join(root, "fixtures/openclaw-sdk-surface/openclaw-2026.9.6.json"), "utf8"));
const sdk906 = modelFlowSdk("2026.9.6");

// 4. The contract is read from the real chunks as text: patched 1, npm original 0, on both versions.
for (const [version, module] of [["2026.9.6", "setup-B7DuERIi.mjs"], ["2026.10.9", "embedded-agent-DoEPu8ye.mjs"]]) {
  const real = modelFlowSdk(version);
  assert.strictEqual(readChunkConstExport(real.patched(module), SYMBOL), 1, version + " patched");
  assert.strictEqual(readChunkConstExport(real.original(module), SYMBOL), 0, version + " npm original");
}
for (const text of [`const ${SYMBOL} = 1;\nexport {};\n`, `const ${SYMBOL} = 1;\nexport { ${SYMBOL} as t };\n`,
  `export const ${SYMBOL} = 1;\nexport const ${SYMBOL} = 2;\n`, `// export const ${SYMBOL} = 1;\n`])
  assert.strictEqual(readChunkConstExport(text, SYMBOL), 0, text);
assert.strictEqual(readChunkConstExport(`const ${SYMBOL} = 3;\nexport { a as b, ${SYMBOL} };\n`, SYMBOL), 3);

(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawmobile-host-capture-")));
  try {
    // Installed OpenClaw 2026.9.6 rebuilt from its real export map and export names (synthetic bodies), with the real
    // patched contract chunk: its own imports are absent here, so importing it would fail.
    const host = path.join(work, "host/lib/node_modules/openclaw"), exportsMap = {};
    fs.mkdirSync(path.join(host, "dist/plugin-sdk"), {recursive: true});
    for (const [subpath, facade] of Object.entries(surface.plugin_sdk)) {
      if (!facade) continue;
      exportsMap["./plugin-sdk/" + subpath] = facade.export;
      fs.writeFileSync(path.join(host, facade.export), facade.exports.map((n) =>
        `export const ${n} = Object.assign(function ${n}() {}, {subpath: ${JSON.stringify(subpath)}});`).join("\n") + "\n");
    }
    fs.writeFileSync(path.join(host, "dist/setup-B7DuERIi.mjs"), sdk906.patched("setup-B7DuERIi.mjs"));
    fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({name: "openclaw", version: "2026.9.6", type: "module", exports: exportsMap}));
    fs.writeFileSync(path.join(host, "openclaw.mjs"), "// never executed\n");
    const bin = path.join(work, "host/bin/openclaw");
    fs.mkdirSync(path.dirname(bin)); fs.symlinkSync(path.join(host, "openclaw.mjs"), bin);
    // Plugin copies laid out like an OpenClaw capture: <capture>/package-0/node_modules/<plugin>, host link at
    // <capture>/node_modules/openclaw (Gateway). The Companion layout has no link.
    const layout = (name, linked) => {
      const capture = path.join(work, name), plugin = path.join(capture, "package-0/node_modules/openclaw-plugin-mobile-ui");
      fs.cpSync(dist, path.join(plugin, "dist"), {recursive: true});
      fs.copyFileSync(path.join(root, "package.json"), path.join(plugin, "package.json"));
      fs.symlinkSync(path.join(root, "node_modules"), path.join(plugin, "node_modules"), "dir");
      if (linked) { fs.mkdirSync(path.join(capture, "node_modules")); fs.symlinkSync(host, path.join(capture, "node_modules/openclaw"), "dir"); }
      return {capture, plugin, load: (file) => require(path.join(plugin, "dist/companion", file))};
    };
    const log = path.join(work, "resolve.log"), hooks = path.join(work, "hooks.mjs");
    fs.writeFileSync(hooks, `import fs from "node:fs";\nexport async function resolve(specifier, context, next) {\n` +
      `  const result = await next(specifier, context);\n` +
      `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([specifier, context.parentURL ?? null, result.url]) + "\\n");\n` +
      `  return result;\n}\n`);
    require("module").register(pathToFileURL(hooks).href);
    const hostUrl = pathToFileURL(host + path.sep).href;
    const hostImports = (capture) => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter(([, parent, url]) => parent?.startsWith(pathToFileURL(capture + path.sep).href) && url.startsWith(hostUrl));
    const loadAll = async ({load}, binary) => {
      const sessions = await load("ownerTurnGateway.js").loadInstalledSessionStoreSdk(binary);
      const turn = await load("ownerTurnGateway.js").loadInstalledGatewaySdk(binary);
      const official = load("officialGatewayOwner.js");
      const gateway = await official.loadOfficialGatewaySdk(binary), media = await official.loadOfficialMediaStore(binary);
      assert.strictEqual(sessions.modelProfileContractVersion, 1, "real patched chunk read as text");
      assert.strictEqual(sessions.getSessionEntry.subpath, "session-store-runtime");
      assert.strictEqual(turn.GatewayClient.subpath, "gateway-runtime");
      assert.strictEqual(gateway.resolveSecretRefValues.subpath, "secret-ref-runtime");
      assert.strictEqual(media.saveMediaBuffer.subpath, "media-store");
      return sessions;
    };

    // 5. Gateway: every host module is imported by bare specifier (never captured), the contract chunk is never
    // imported, and the plugin shares the host's own module instance. The CLI binary is not even consulted.
    const gateway = layout("gateway-capture", true);
    const sessions = await loadAll(gateway, path.join(work, "no-such-binary"));
    const imports = hostImports(gateway.capture);
    assert.ok(imports.length >= 6, JSON.stringify(imports));
    const captured = imports.filter(([specifier]) => specifier.startsWith("file:") || path.isAbsolute(specifier));
    assert.deepStrictEqual(captured, [], "host modules the Gateway would copy into the plugin capture");
    assert.ok(imports.every(([specifier]) => specifier.startsWith("openclaw/plugin-sdk/")), JSON.stringify(imports));
    assert.ok(!fs.readFileSync(log, "utf8").includes("setup-B7DuERIi.mjs"), "contract chunk imported");
    const shared = await import(pathToFileURL(path.join(host, "dist/plugin-sdk/session-store-runtime.js")).href);
    assert.strictEqual(sessions.getSessionEntry, shared.getSessionEntry, "same host module instance");

    // 6. Companion (no capture, no link): the installed package found from the CLI binary, by file URL as before.
    const companion = layout("companion", false);
    await loadAll(companion, bin);
    assert.ok(hostImports(companion.capture).every(([specifier]) => specifier.startsWith(hostUrl)));
    assert.ok(!fs.readFileSync(log, "utf8").includes("setup-B7DuERIi.mjs"));
    console.log("plugin capture size test passed: captured", captured.length === 0 ? "ws" : "?", "(19 of 635 files);",
      imports.length, "host imports by bare specifier, contract read as text, host instance shared");
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
