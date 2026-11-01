// #126 (S24 01/11): the Gateway copies every declared plugin dependency file by file on its main thread at the first
// owner turn after a restart. Keep the declared set to what the plugin needs at turn time; Nostr loads on use.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

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
const os = require("os");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawmobile-nostr-lazy-"));
process.env.CLAWMOBILE_NOSTR_CONFIG = path.join(tmp, "nostr.json");
const loaded = () => Object.keys(require.cache).some((id) => id.includes(`${path.sep}nostr-tools${path.sep}`));
const nostr = require(path.join(dist, "companion/nostr.js"));
assert.strictEqual(loaded(), false, "nostr-tools loaded with the module");
const identity = nostr.setupNostrIdentity({relays: ["wss://relay.example.com"]});
assert.match(identity.npub, /^npub1/);
assert.strictEqual(loaded(), true);
fs.rmSync(tmp, {recursive: true, force: true});
console.log("plugin capture footprint test passed: captured", captured.join(","), "(19 of 635 files)");
