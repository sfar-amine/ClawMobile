const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const mod = require("../dist/companion/clawLive.js");
  const tempRoot = process.env.TMPDIR || path.join(os.homedir(), ".openclaw", "tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const home = fs.mkdtempSync(path.join(tempRoot, "claw-live-test-"));
  const workspace = path.join(home, ".openclaw", "workspace");
  fs.mkdirSync(path.join(workspace, "context"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "memory", "voice"), { recursive: true });
  fs.mkdirSync(path.join(home, ".openclaw", "capability-views"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "SOUL.md"), "# SOUL\nIDENTITY_CANONICAL Samantha\n");
  fs.writeFileSync(path.join(workspace, "context", "OPERATING_RULES.md"), "OPERATING_CANONICAL\n");
  fs.writeFileSync(path.join(workspace, "memory", "voice", "amine.md"), "VOICE_CANONICAL\n");
  fs.writeFileSync(path.join(workspace, "context", "HYBRID_CONTEXT.md"), "MEMORY_CANONICAL\n");
  fs.writeFileSync(path.join(home, ".openclaw", "capability-views", "claw_live.md"), "CAPABILITY_CANONICAL\n");

  let seenHeaders;
  let seenBody;
  const fakeFetch = async (_url, init) => {
    seenHeaders = init.headers;
    seenBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          name: "ephemeral-test-token",
          expireTime: "2026-09-30T12:30:00Z",
          newSessionExpireTime: "2026-09-30T12:01:00Z",
        };
      },
    };
  };
  const token = await mod.createClawLiveToken(fakeFetch, async () => "secret-test-key", {
    home, locale: "fr-FR", client: "samantha_android",
  });
  assert.equal(token.token, "ephemeral-test-token");
  assert.equal(token.model, "gemini-3.8-live");
  assert.equal(token.locale, "fr");
  assert.equal(token.client, "samantha_android");
  assert.equal(seenHeaders["x-goog-api-key"], "secret-test-key");
  assert.equal(seenBody.uses, 1);
  assert.equal(token.setup.model, "models/gemini-3.8-live");
  assert.equal(token.setup.realtimeInputConfig.automaticActivityDetection.disabled, true);
  const prompt = token.setup.systemInstruction.parts[0].text;
  for (const marker of ["IDENTITY_CANONICAL", "OPERATING_CANONICAL", "VOICE_CANONICAL", "MEMORY_CANONICAL", "CAPABILITY_CANONICAL"]) {
    assert.ok(prompt.includes(marker), marker);
  }
  assert.equal(token.setup.tools[0].functionDeclarations[0].name, "clawmobile_capability");

  const html = mod.clawLivePageHtml();
  assert.ok(html.includes("Claw Live"));
  assert.ok(html.includes("/v1/extensions/claw-live/token"));
  assert.ok(html.includes("/v1/extensions/claw-live/capability"));
  assert.ok(html.includes("BidiGenerateContentConstrained"));
  assert.ok(html.includes("voice_bootstrap_missing"));
  assert.equal(html.includes("You are Samantha in Claw Live."), false);
  assert.equal(html.includes("GEMINI_API_KEY"), false);
  assert.equal(html.includes("secret-test-key"), false);
  console.log(JSON.stringify({ ok: true, token: true, canonicalBootstrap: true, browserSurface: true }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
