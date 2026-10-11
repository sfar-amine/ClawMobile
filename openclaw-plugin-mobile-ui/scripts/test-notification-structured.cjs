// F4 (fichiers 35/41) : notifications structurées {title, body, fields[]} sur la capture
// réelle de GET /v1/runs?limit=40&summary=1 (fixtures/s24-2026-10-11b/f4), texte brut
// `result` conservé en repli, sans appel Gateway.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawmobile-f4-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "openclaw-state");
process.env.CLAWMOBILE_AGENT_ID = "main";
const calls = path.join(root, "gateway-calls.txt");
const fake = path.join(root, "fake-openclaw.sh");
fs.writeFileSync(fake, `#!/bin/sh\necho call >> "${calls}"\nexit 1\n`);
fs.chmodSync(fake, 0o700);
process.env.CLAWMOBILE_OPENCLAW_BIN = fake;

const fixture = require(path.resolve(__dirname, "..", "fixtures", "s24-2026-10-11b", "f4", "runs.summary.notifications.json"));
const captured = fixture.response.runs;
assert.strictEqual(captured.length, 17);

const registryDir = path.join(process.env.OPENCLAW_STATE_DIR, "clawmobile-companion");
fs.mkdirSync(registryDir, { recursive: true });
fs.writeFileSync(path.join(registryDir, "runs.json"), JSON.stringify({
  version: 1, archivedSessionIds: [], paymentRequests: [], ownerConfirmations: [],
  runs: captured.map((run, index) => ({
    runId: `f4-${index}`, sessionId: `s-${index}`, text: run.userText, userText: run.userText,
    acceptedAt: 1000 + index, updatedAt: 2000 + index, result: run.result,
    ...(run.modality === "voice" ? { modality: "voice", transcriptState: run.transcriptState } : { state: "done" }),
  })),
}));

const { listRunSummaries } = require("../dist/companion/runs.js");
const { structuredNotification } = require("../dist/companion/notificationText.js");

(async () => {
  const started = Date.now();
  const summaries = await listRunSummaries({ limit: 40 });
  const elapsed = Date.now() - started;
  assert.strictEqual(summaries.length, 17);
  assert.strictEqual(fs.existsSync(calls), false, "aucun appel Gateway");
  assert.ok(elapsed < 1000, `lecture sous budget (${elapsed} ms)`);

  const byKind = { markdown: 0, json: 0, plain: 0, empty: 0 };
  summaries.forEach((summary) => {
    const run = captured[Number(summary.runId.slice(3))];
    assert.strictEqual(summary.result, run.result, "texte brut conservé en repli");
    const note = summary.notification;
    if (!run.result) { assert.strictEqual(note, null); byKind.empty++; return; }
    assert.strictEqual(note.version, 1);
    assert.strictEqual(note.rawFallback, "result");
    assert.ok(note.title.length > 0 && note.title.length <= 80);
    assert.ok(Array.isArray(note.fields));
    if (run._resultKind === "markdown") {
      byKind.markdown++;
      assert.strictEqual(note.format, "markdown");
      assert.ok(!note.body.includes("**"), "plus de ** affichés");
      assert.strictEqual(note.body, run.result.replace(/\*\*/g, ""), "aucune perte de texte");
      const bold = run.result.match(/\*\*([^*\n]+)\*\*/g).map((m) => m.slice(2, -2));
      assert.deepStrictEqual(note.emphasis.map((e) => note.body.slice(e.start, e.end)), bold);
    } else if (run._resultKind === "json") {
      byKind.json++;
      assert.strictEqual(note.format, "json");
      assert.ok(note.fields.length > 0);
      assert.ok(!note.body.includes("{"), "pas de JSON brut");
      for (const field of note.fields) {
        assert.ok(!/^(ok|run_id|source|transport|ui_used|latency_ms|observed_at|blocked_by)$/.test(field.key.split(".").at(-1)), field.key);
        assert.ok(field.label && field.value.length <= 120);
      }
      const value = JSON.parse(run.result);
      if ("level_percent" in value) {
        assert.deepStrictEqual(note.fields.map((f) => f.label), ["État", "Opération", "Niveau (%)", "En charge", "Branché"]);
        assert.strictEqual(note.fields.find((f) => f.key === "charging").value, value.charging ? "oui" : "non");
      }
      if (value.data && value.data.cards) {
        const cards = note.fields.filter((f) => f.key.startsWith("data.cards["));
        assert.strictEqual(cards.length, Math.min(value.data.cards.length, 12 - note.fields.length + cards.length));
        assert.strictEqual(cards[0].label, value.data.cards[0].title);
        assert.strictEqual(cards[0].value, `${value.data.cards[0].value} ${value.data.cards[0].unit}`);
      }
    } else {
      byKind.plain++;
      assert.strictEqual(note.format, "plain");
      assert.strictEqual(note.body, run.result.trim());
      assert.deepStrictEqual(note.fields, []);
    }
  });
  assert.deepStrictEqual(byKind, { markdown: 3, json: 6, plain: 6, empty: 2 });

  // Formes reconnues hors capture et repli sans perte.
  const kv = structuredNotification("État: actif\nNiveau=42\nForfait : Mix", "Mon forfait");
  assert.strictEqual(kv.format, "key_value");
  assert.strictEqual(kv.title, "Mon forfait");
  assert.deepStrictEqual(kv.fields.map((f) => [f.key, f.value]), [["État", "actif"], ["Niveau", "42"], ["Forfait", "Mix"]]);
  assert.strictEqual(structuredNotification("{pas du json", "").format, "plain");
  assert.strictEqual(structuredNotification("[1,2]", "").format, "plain");
  assert.strictEqual(structuredNotification("Une ligne : sans structure", "").format, "plain");
  assert.strictEqual(structuredNotification("   ", "x"), null);
  const huge = "{" + "\"a\":1,".repeat(5000) + "\"b\":2}";
  assert.strictEqual(structuredNotification(huge, "").format, "plain", "au-delà de 16 Kio : texte brut");

  // Budget : 100 résultats de 1 292 caractères (taille max capturée).
  const long = captured.find((r) => r._resultKind === "markdown").result.padEnd(1292, " x");
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) structuredNotification(long, "demande");
  assert.ok(Date.now() - t0 < 200, "projection négligeable dans la lecture");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, test: "notification-structured", ...byKind, listMs: elapsed }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
