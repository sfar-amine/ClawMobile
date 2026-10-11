// O6 (fichier 37) : un appel du fast path qui exécute n'est jamais tué avant l'attente gardée
// (garde 60 s, attente du helper 70 s). Mesures : fixtures/s24-2026-10-11/o6-network-guard-timing.json.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {fastPathProcessTimeoutMs, GUARDED_ENTRY_WAIT_S} = require("../dist/modelFastPath.js");
const timing = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/s24-2026-10-11/o6-network-guard-timing.json"), "utf8"));

const bound = timing.proposed_total_bound.value_s;
assert.equal(bound, 60);
assert.ok(GUARDED_ENTRY_WAIT_S >= bound + 5);
// Owner inbound (WhatsApp/node) asks 30 s: the process is still allowed the guarded wait.
assert.ok(fastPathProcessTimeoutMs(30, false) >= (GUARDED_ENTRY_WAIT_S + 5) * 1000);
// App capability_first asks 75 s: its own budget wins when larger.
assert.equal(fastPathProcessTimeoutMs(75, false), (75 + 15) * 1000);
// Check-only preflight keeps its short budget (no execution, no Wi-Fi change).
assert.equal(fastPathProcessTimeoutMs(1, true), 9 * 1000);
assert.equal(fastPathProcessTimeoutMs(12, true), 20 * 1000);
// Far above every observed guarded entry (max total 6.3 s).
assert.ok(fastPathProcessTimeoutMs(30, false) > 10 * timing.stats_ms.entrypoint_total.max);
console.log("O6 guarded entry wait: PASS");
