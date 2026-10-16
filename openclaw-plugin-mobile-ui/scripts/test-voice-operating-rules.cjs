const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {compactVoiceOperatingRules, buildClawLiveSetup} = require('../dist/companion/clawLive.js');
const capture = require('../fixtures/s24-2026-10-10/context/operating-rules-shape.json');
const {specializedHeadingAt, specializedSection} = capture.response;
// Generated filler represents redacted middle text, at the position measured on the S24.
const head = '# Operating Rules\nCANONICAL_START\n';
const raw = head + 'x'.repeat(specializedHeadingAt - head.length - 1) + '\n' + specializedSection;
assert.equal(raw.length, capture.response.lengthChars);
const compact = compactVoiceOperatingRules(raw);
assert.ok(compact.startsWith(head));
assert.ok(compact.includes(specializedSection.trim()));
assert.ok(compact.length <= 12000);
assert.equal(compactVoiceOperatingRules('short legacy contract'), 'short legacy contract');
assert.throws(() => compactVoiceOperatingRules('long\n## Règles spécialisées\n' + 'x'.repeat(15000)), /too_large/);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rules-'));
try {
  const context = path.join(home, '.openclaw', 'workspace', 'context');
  fs.mkdirSync(context, {recursive:true});
  fs.writeFileSync(path.join(context, 'OPERATING_RULES.md'), raw);
  const samples = [];
  for (let n = 0; n < 25; n++) {
    const before = performance.now();
    const {setup} = buildClawLiveSetup('gemini-3.8-live', {home});
    samples.push(performance.now() - before);
    assert.ok(setup.systemInstruction.parts[0].text.includes(specializedSection.trim()));
    assert.ok(setup.systemInstruction.parts[0].text.includes('first say one very short waiting phrase'), 'waiting phrase rule missing (Amine 11/10)');
  }
  samples.sort((a,b) => a-b);
  assert.ok(samples[23] < 100, 'bounded local bootstrap exceeded 100 ms');
  console.log(JSON.stringify({ok:true, source:capture._capture.source, projectedChars:compact.length, localBootstrapP95Ms:samples[23], physicalVoiceLatency:'not_measured'}));
} finally { fs.rmSync(home, {recursive:true, force:true}); }
