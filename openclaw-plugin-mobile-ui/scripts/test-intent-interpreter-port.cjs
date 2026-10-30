const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const port = require("../dist/intentInterpreterPort.js");

const GEMINI = port.GEMINI, SOL = port.SOL;
const LUNA = port.LUNA;
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
  // Amine 29/10: Sol answers first: one call, no fallback, subscription OAuth required.
  {
    const f = fake([{ text: "```json\n" + JSON.stringify(decision) + "\n```", provider: "openai", model: "gpt-5.6-sol" }]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, true);
    assert.deepEqual(out.decision, decision);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].model, SOL);
    assert.equal(f.calls[0].requiredAuthMode, "oauth");
    assert.equal(out.fallbackReason, undefined);
  }
  // Technical failures of Sol reach Gemini free, pinned to its profile without OAuth.
  for (const code of ["LLM_COMPLETION_TIMEOUT", "LLM_COMPLETION_FAILED", "LLM_RUNTIME_UNAVAILABLE", "LLM_COMPLETION_OUTPUT_REJECTED"]) {
    const f = fake([failure(code), { text: JSON.stringify(decision), provider: "google", model: "gemini-3.5-flash-lite" }]);
    const out = await port.interpret(f.complete, req);
    assert.equal(out.ok, true, code);
    assert.equal(f.calls[1].model, GEMINI);
    assert.equal(f.calls[1].requiredAuthMode, undefined);
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
  // An authorization refusal never reaches the fallback.
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
  // A Sol timeout aborts its call and leaves the remaining budget to Gemini.
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
    const single = port.validateRequest({ systemPrompt: "x", message: "y", model: SOL });
    const out = await port.interpret(f.complete, single);
    assert.equal(f.calls.length, 1);
    assert.equal(out.ok, false);
    assert.equal(out.code, "LLM_COMPLETION_TIMEOUT");
    const gemini = fake([{ text: JSON.stringify(decision) }]);
    const ok = await port.interpret(gemini.complete, port.validateRequest({ systemPrompt: "x", message: "y", model: GEMINI }));
    assert.equal(ok.ok, true);
    assert.equal(gemini.calls[0].requiredAuthMode, undefined);
    // Amine 30/10: the chain is set from the app among the qualified Sol/Luna/Gemini free set, never beyond it.
    assert.notEqual(port.validateRequest({ systemPrompt: "x", message: "y", model: LUNA }), null, 'Luna is an admissible interpreter choice');
    assert.deepEqual([...port.INTERPRETER_ADMITTED], [...port.IMMUNE_MODELS]);
    assert.equal(port.validateRequest({ systemPrompt: "x", message: "y", model: "openai/gpt-5.6-terra" }), null, 'an unqualified model stays refused');
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
  // The single-brain switch concerns Amine. A contact's professional AI stays the one admitted Gemini profile,
  // on the Pulse catalogue only. The room is admitted at its turn and Python re-reads the sealed contact evidence
  // at send: the Gateway keeps no third lease (S24 28-29/10, every room message was refused by it).
  {
    const old=process.env.SAMANTHA_BRAIN_ONLY;process.env.SAMANTHA_BRAIN_ONLY='1';
    const replies=[];let calls=0;
    const request={message:{ref:'evt-authored',text:'état du projet 20495',provenance:'server_verified'},catalogue:{domains:[{domain_id:'pulse'}]}};
    const params={systemPrompt:'authored professional fixture',message:'REQUEST='+JSON.stringify(request),purpose:port.NATIVE_PULSE_PURPOSE,model:GEMINI};
    const handler=port.createInterpretHandler(()=>async()=>{calls++;return {text:JSON.stringify({outcome:'intent',domain:'pulse',intent_id:'project.phases',parameters:{project_id:'20495'}})};});
    try{
      await handler({params,respond:(...v)=>replies.push(v)});
      assert.equal(calls,1);assert.equal(replies.at(-1)[0],true,'a room interpretation needs no Gateway lease');
      for(const invalid of [{...params,model:'openai/gpt-5.6-terra'},{...params,message:'état du projet 20495'},
          {...params,message:'REQUEST='+JSON.stringify({...request,catalogue:{domains:[{domain_id:'pulse'},{domain_id:'owner_private'}]}})},
          {...params,message:'REQUEST={'}]){
        await handler({params:invalid,respond:(...v)=>replies.push(v)});
        assert.equal(calls,1,'other model, owner catalogue or malformed request: refused before the model');assert.equal(replies.at(-1)[0],false);
      }
    }finally{if(old===undefined)delete process.env.SAMANTHA_BRAIN_ONLY;else process.env.SAMANTHA_BRAIN_ONLY=old;}
  }
  // The credential-owner port also serves C2 Sol -> Luna -> Gemini free. C1 still rejects Sol above.
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
