const assert = require("node:assert/strict");

async function main() {
  const mod = require("../dist/companion/clawLive.js");
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
  const token = await mod.createClawLiveToken(fakeFetch, async () => "secret-test-key");
  assert.equal(token.token, "ephemeral-test-token");
  assert.equal(token.model, "gemini-3.8-live");
  assert.equal(seenHeaders["x-goog-api-key"], "secret-test-key");
  assert.equal(seenBody.uses, 1);

  const html = mod.clawLivePageHtml();
  assert.ok(html.includes("Claw Live"));
  assert.ok(html.includes("clawmobile_capability"));
  assert.ok(html.includes("/v1/extensions/claw-live/token"));
  assert.ok(html.includes("/v1/extensions/claw-live/capability"));
  assert.ok(html.includes("BidiGenerateContentConstrained"));
  assert.equal(html.includes("GEMINI_API_KEY"), false);
  assert.equal(html.includes("secret-test-key"), false);
  console.log(JSON.stringify({ ok: true, token: true, browserSurface: true }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
