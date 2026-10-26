const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const port = require("../dist/intentInterpreterPort.js");

const GEMINI = port.INTERPRETER_PRIMARY;
const LUNA = port.INTERPRETER_FALLBACK;
const decision = { outcome: "intent", domain: "telecom", intent_id: "telecom.balance", parameters: { line: "orange" } };
const req = port.validateRequest({ systemPrompt: "catalogue", message: "c'est quoi mon solde orange ?" });
const failure = (code) => Object.assign(new Error(code), { code });

function fake(script) {
  const calls = [];
  const complete = async (params) => {
    calls.push(params);
    const step = script[calls.length - 1];
    if (typeof step === "function") return step(params);
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, complete };
}

(async () => {
  // Gemini answers: one call, no fallback, free profile pinned, no OAuth requirement.
  {
    const f = fake([{ text: "```json\n" + JSON.stringify(decision) + "\n```", provider: "google", model: "gemini-3.5-flash-lite" }]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, true);
    assert.deepEqual(out.decision, decision);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].model, GEMINI);
    assert.equal(f.calls[0].requiredAuthMode, undefined);
    assert.equal(out.fallbackReason, undefined);
  }
  // Technical failures of Gemini reach Luna, with OAuth required.
  for (const code of ["LLM_COMPLETION_TIMEOUT", "LLM_COMPLETION_FAILED", "LLM_RUNTIME_UNAVAILABLE", "LLM_COMPLETION_OUTPUT_REJECTED"]) {
    const f = fake([failure(code), { text: JSON.stringify(decision), provider: "openai", model: "gpt-5.6-luna" }]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, true, code);
    assert.equal(f.calls[1].model, LUNA);
    assert.equal(f.calls[1].requiredAuthMode, "oauth");
    assert.equal(out.fallbackReason, code);
  }
  // Unparsable output is technical too.
  {
    const f = fake([{ text: "Bien sûr ! Voici." }, { text: JSON.stringify(decision) }]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, true);
    assert.equal(out.fallbackReason, "INVALID_DECISION_OUTPUT");
  }
  // A provider error resolves with empty text and a non-completed stop reason (S24 25/10 18:24Z,
  // gpt-5.6-sol 429 usage_limit_reached, zero usage): a provider failure, not an invalid decision.
  {
    const f = fake([{ text: "", stopReason: "error", provider: "google", model: "gemini-3.5-flash-lite" }, { text: JSON.stringify(decision) }]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, true);
    assert.equal(out.fallbackReason, "LLM_COMPLETION_FAILED");
    const empty = fake([{ text: "", stopReason: "stop" }, { text: JSON.stringify(decision) }]);
    assert.equal((await port.interpret(empty.complete, req)).fallbackReason, "INVALID_DECISION_OUTPUT");
  }
  // An authorization refusal never reaches Luna.
  {
    const f = fake([failure("LLM_COMPLETION_NOT_AUTHORIZED")]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, false);
    assert.equal(out.code, "LLM_COMPLETION_NOT_AUTHORIZED");
    assert.equal(f.calls.length, 1);
  }
  // Both models down: stable unavailable code, two attempts recorded.
  {
    const f = fake([failure("LLM_COMPLETION_FAILED"), failure("LLM_COMPLETION_TIMEOUT")]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, false);
    assert.equal(out.code, "INTERPRETER_UNAVAILABLE");
    assert.equal(out.attempts.length, 2);
  }
  // A Gemini timeout aborts its call and leaves the remaining budget to Luna.
  {
    let aborted = false;
    const hang = (params) => new Promise((_, reject) => params.signal.addEventListener("abort", () => { aborted = true; reject(failure("LLM_COMPLETION_ABORTED")); }));
    const f = fake([hang, { text: JSON.stringify(decision) }]);
    const out = await port.interpret(f.complete, { ...req, primaryTimeoutMs: 300, totalTimeoutMs: 3000 });
    assert.equal(aborted, true);
    assert.equal(out.ok, true);
    assert.equal(out.fallbackReason, "LLM_COMPLETION_TIMEOUT");
  }
  // A governed single-model call never falls back by itself and keeps the technical code.
  {
    const f = fake([failure("LLM_COMPLETION_TIMEOUT")]);
    const single = port.validateRequest({ systemPrompt: "x", message: "y", model: GEMINI });
    const out = await port.interpret(f.complete, single);
    assert.equal(f.calls.length, 1);
    assert.equal(out.ok, false);
    assert.equal(out.code, "LLM_COMPLETION_TIMEOUT");
    const luna = fake([{ text: JSON.stringify(decision) }]);
    const ok = await port.interpret(luna.complete, port.validateRequest({ systemPrompt: "x", message: "y", model: LUNA }));
    assert.equal(ok.ok, true);
    assert.equal(luna.calls[0].requiredAuthMode, "oauth");
    assert.equal(port.validateRequest({ systemPrompt: "x", message: "y", model: "openai/gpt-5.6-sol" }), null);
  }
  // Only one JSON object is a decision; its contract belongs to the playbooks owner.
  assert.equal(port.parseDecision("[1,2]"), null);
  assert.equal(port.parseDecision("x".repeat(9000)), null);
  assert.deepEqual(port.parseDecision(JSON.stringify({ status: "selected" })), { status: "selected" });
  // Invalid requests are refused before any model call.
  assert.equal(port.validateRequest({ systemPrompt: "", message: "x" }), null);
  assert.equal(port.validateRequest({ systemPrompt: "x", message: "y".repeat(97000) }), null);
  assert.notEqual(port.validateRequest({ systemPrompt: "x", message: "y".repeat(40000) }), null);
  // Gateway handler: invalid request and missing runtime answer with stable codes.
  {
    const replies = [];
    const handler = port.createInterpretHandler(() => undefined);
    await handler({ params: { systemPrompt: "x", message: "y" }, respond: (...a) => replies.push(a) });
    await port.createInterpretHandler(() => async () => ({}))({ params: {}, respond: (...a) => replies.push(a) });
    assert.equal(replies[0][2].code, "UNAVAILABLE");
    assert.equal(replies[1][2].code, "INVALID_REQUEST");
  }
  // The credential-owner port also serves C2 Sol -> Luna -> Gemini free. C1 still rejects Sol above.
  {
    const old=process.env.SAMANTHA_BRAIN_ONLY;process.env.SAMANTHA_BRAIN_ONLY='1';
    let entered=0;const replies=[];
    try{
      const handler=port.createInterpretHandler(()=>{entered++;return async()=>{throw Error('no dedicated model call');};});
      await handler({params:{systemPrompt:'catalogue',message:'REQUEST={}',purpose:port.NATIVE_PULSE_PURPOSE,model:GEMINI},respond:(...v)=>replies.push(v)});
      assert.equal(entered,0);assert.equal(replies[0][0],false);
      assert.equal(replies[0][2].message,'dedicated intent interpreter retired');
    }finally{if(old===undefined)delete process.env.SAMANTHA_BRAIN_ONLY;else process.env.SAMANTHA_BRAIN_ONLY=old;}
  }
  assert.deepEqual([...port.IMMUNE_MODELS],['openai/gpt-5.6-sol',LUNA,GEMINI]);
  for(const model of port.IMMUNE_MODELS){
    const google=model===GEMINI;
    const engineering=port.validateRequest({systemPrompt:'public code fixture',message:'diagnose',purpose:port.IMMUNE_PURPOSE,model,totalTimeoutMs:90000});
    assert.ok(engineering);assert.equal(engineering.totalTimeoutMs,90000);
    const f=fake([{text:JSON.stringify({files:[{content:'x'.repeat(9000)}]}),provider:google?'google':'openai',model:model.split('@')[0].split('/')[1]}]);
    assert.equal((await port.interpret(f.complete,engineering)).ok,true);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].model,model);
    assert.equal(f.calls[0].requiredAuthMode,google?undefined:'oauth');
    assert.equal(f.calls[0].agentId,undefined);assert.equal(f.calls[0].tools,undefined);
    const limited=fake([{text:'',stopReason:'error',provider:google?'google':'openai',model:model.split('@')[0].split('/')[1]}]);
    const quota=await port.interpret(limited.complete,engineering);
    assert.equal(quota.ok,false);assert.equal(quota.code,'LLM_COMPLETION_FAILED');assert.equal(limited.calls.length,1);
    const down=fake([failure('LLM_COMPLETION_FAILED')]);
    assert.equal((await port.interpret(down.complete,engineering)).ok,false);assert.equal(down.calls.length,1);
  }
  assert.equal(port.validateRequest({systemPrompt:'x',message:'y',purpose:port.IMMUNE_PURPOSE}),null);
  assert.equal(port.validateRequest({systemPrompt:'x',message:'y',purpose:port.IMMUNE_PURPOSE,model:GEMINI.split('@')[0]}),null);
  assert.equal(port.validateRequest({systemPrompt:'x',message:'y',purpose:port.IMMUNE_PURPOSE,model:'google/gemini-3.5-pro'}),null);
  // Exact native completion allowlist; no agent or auth-profile override.
  // OpenClaw 2026.9.6 matches the allowlist on provider/model only (the resolved ref carries no
  // "@profile"); a suffixed entry never matches and refuses every Gemini call. The free profile
  // stays pinned by the request ("model@profile"), which OpenClaw checks against the credential used.
  const patch = JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/runtime/config/samantha-intent-interpreter.json"), "utf8"));
  const llm = patch.plugins.entries["openclaw-plugin-mobile-ui"].llm;
  const GEMINI_KEY = GEMINI.split("@")[0];
  assert.equal(GEMINI, `${GEMINI_KEY}@google:claw-gemini-free`);
  assert.deepEqual(Object.keys(patch), ["plugins"]);
  assert.deepEqual(llm.allowedModels, [GEMINI_KEY, LUNA, port.IMMUNE_MODELS[0]]);
  assert.deepEqual(llm.allowedCompletionModels, [GEMINI_KEY, LUNA, port.IMMUNE_MODELS[0]]);
  assert.ok([...llm.allowedModels, ...llm.allowedCompletionModels].every((m) => !m.includes("@")));
  assert.equal(llm.allowAgentIdOverride, undefined);
  assert.equal(llm.allowAuthProfileOverride, undefined);
  console.log(JSON.stringify({ ok: true, primary: GEMINI, fallback: LUNA, technicalFallbackOnly: true }));
})().catch((error) => { console.error(error); process.exit(1); });
