const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const mod = require("../dist/providerFallback.js");

  const api = {
    config: { channels: { whatsapp: { allowFrom: ["+21611111111"] } } },
    logger: { warn() {} },
  };

  assert.equal(
    mod.isEligibleTrustedWhatsApp(
      {
        agentId: "main",
        trigger: "user",
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:direct:+21611111111",
      },
      api.config,
    ),
    true,
  );
  assert.equal(
    mod.isEligibleTrustedWhatsApp(
      {
        agentId: "main",
        trigger: "user",
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:direct:+21622222222",
      },
      api.config,
    ),
    false,
  );
  assert.equal(
    mod.isOpenAiTerminalError("Provider openai is in cooldown"),
    true,
  );
  assert.equal(mod.isOpenAiTerminalError("ordinary answer"), false);

  let calls = 0;
  const coordinator = mod.createProviderFallbackCoordinator(api, async (prompt) => {
    calls += 1;
    assert.equal(prompt, "question text");
    return {
      status: "ok",
      text: "fallback answer",
      provider: "google",
      model: "gemini-3.5-flash-lite",
      rerouted: false,
      reported_cost_usd: 0,
    };
  });
  const ctx = {
    runId: "run-ok",
    agentId: "main",
    trigger: "user",
    channel: "whatsapp",
    sessionKey: "agent:main:whatsapp:direct:+21611111111",
  };
  coordinator.beforeModelResolve({ prompt: "question text" }, ctx);
  coordinator.modelCallEnded({ runId: "run-ok", provider: "openai", outcome: "error" }, ctx);
  const recovered = await coordinator.beforeAgentReply(
    { cleanedBody: "Provider openai is in cooldown" },
    ctx,
  );
  assert.deepEqual(recovered, {
    handled: true,
    reply: { text: "fallback answer" },
    reason: "provider_fallback_google_free",
  });
  assert.equal(calls, 1);
  assert.equal(coordinator._stateSize(), 0);

  let actionFallbackCalls = 0;
  const actionCoordinator = mod.createProviderFallbackCoordinator(api, async () => {
    actionFallbackCalls += 1;
    return {
      status: "ok",
      text: "must not happen",
      provider: "google",
      rerouted: false,
      reported_cost_usd: 0,
    };
  });
  const actionCtx = { ...ctx, runId: "run-tool" };
  actionCoordinator.beforeModelResolve({ prompt: "do something" }, actionCtx);
  actionCoordinator.modelCallEnded(
    { runId: "run-tool", provider: "openai", outcome: "error" },
    actionCtx,
  );
  actionCoordinator.beforeToolCall({ runId: "run-tool", toolName: "some_tool" }, actionCtx);
  const actionResult = await actionCoordinator.beforeAgentReply(
    { cleanedBody: "Provider openai is in cooldown" },
    actionCtx,
  );
  assert.equal(actionResult, undefined);
  assert.equal(actionFallbackCalls, 0);

  let unsafeCalls = 0;
  const unsafeCoordinator = mod.createProviderFallbackCoordinator(api, async () => {
    unsafeCalls += 1;
    return {
      status: "ok",
      text: "paid",
      provider: "google",
      rerouted: false,
      reported_cost_usd: 0.01,
    };
  });
  const unsafeCtx = { ...ctx, runId: "run-paid" };
  unsafeCoordinator.beforeModelResolve({ prompt: "question" }, unsafeCtx);
  unsafeCoordinator.modelCallEnded(
    { runId: "run-paid", provider: "openai", outcome: "error" },
    unsafeCtx,
  );
  const unsafeResult = await unsafeCoordinator.beforeAgentReply(
    { cleanedBody: "Provider openai is in cooldown" },
    unsafeCtx,
  );
  assert.equal(unsafeResult, undefined);
  assert.equal(unsafeCalls, 1);

  const promptPolicy = coordinator.beforePromptBuild(
    { prompt: "x", messages: [] },
    {
      agentId: "gemini",
      sessionKey: "agent:gemini:channel-provider-fallback-trusted-test",
    },
  );
  assert.deepEqual(promptPolicy, { toolsAllow: [] });

  const normalPromptPolicy = coordinator.beforePromptBuild(
    { prompt: "x", messages: [] },
    { agentId: "gemini", sessionKey: "agent:gemini:channel-normal" },
  );
  assert.equal(normalPromptPolicy, undefined);

  const attachmentCoordinator = mod.createProviderFallbackCoordinator(api, async () => {
    throw new Error("attachment fallback must not run");
  });
  const attachmentCtx = { ...ctx, runId: "run-attachment" };
  attachmentCoordinator.beforeModelResolve(
    { prompt: "see image", attachments: [{ kind: "image" }] },
    attachmentCtx,
  );
  assert.equal(attachmentCoordinator._stateSize(), 0);

  // Exercise the real default child-process runner. On Android/Termux,
  // promisified execFile can report exit=0 with empty stdout; spawn+pipe must
  // preserve the wrapper JSON contract. A PATH-local shim keeps this test
  // provider-free while verifying the actual process collection path.
  const tempRoot = process.env.TMPDIR || path.join(os.homedir(), ".cache", "tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const shimDir = fs.mkdtempSync(path.join(tempRoot, "provider-fallback-runner-"));
  const shim = path.join(shimDir, "python3");
  fs.writeFileSync(
    shim,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({status:"ok",text:"default runner answer",provider:"google",model:"gemini-3.5-flash-lite",rerouted:false,reported_cost_usd:0}));\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + (oldPath || "");
  try {
    const defaultCoordinator = mod.createProviderFallbackCoordinator(api);
    const defaultCtx = { ...ctx, runId: "run-default-runner" };
    defaultCoordinator.beforeModelResolve({ prompt: "question text" }, defaultCtx);
    defaultCoordinator.modelCallEnded(
      { runId: "run-default-runner", provider: "openai", outcome: "error" },
      defaultCtx,
    );
    const defaultRecovered = await defaultCoordinator.beforeAgentReply(
      { cleanedBody: "Provider openai is in cooldown" },
      defaultCtx,
    );
    assert.deepEqual(defaultRecovered, {
      handled: true,
      reply: { text: "default runner answer" },
      reason: "provider_fallback_google_free",
    });
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(shimDir, { recursive: true, force: true });
  }

  console.log("provider-fallback plugin tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
