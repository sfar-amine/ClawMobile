const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MEMO_STT_QUALIFICATION, MEMO_TRANSCRIPTION_PROMPT, qualifyMemoStt, memoSttOwnerFailure, projectMemoTranscript } = require('../dist/companion/memoSttBoundary');
const { MEMO_STT_QUALIFICATION_RECEIPT } = require('../dist/companion/memoSttQualificationReceipt');
const { isM4aContainer, memoAudioDurationWithinLimit } = require('../dist/companion/attachmentStorage');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-11/hs8/sdk-exports.json'), 'utf8'));
assert.equal(fixture.provenance.state, 'completed');
assert.equal(fixture.provenance.exitCode, 0);
assert.equal(fixture.exports.version, '2026.9.6');
for (const key of ['publicExport','transcribeAudioFileExported','transcribeSignaturePresent','runMediaUnderstandingFileExported','loadConfigExported']) assert.equal(fixture.exports[key], true);
for (const key of ['provider','audioFixture','globalDeadline','sdkLogPrivacy']) assert.equal(fixture.qualification[key], false);
// The export probe above is historical and never qualifies. Admission comes only from the S24
// receipt of 17/10 (canonical owner, exact model/profile/SDK/prompt, mp42 container, exact transcript).
const qualDir = path.join(__dirname, '../fixtures/s24-2026-10-17/hs8-qualification');
const receipt = JSON.parse(fs.readFileSync(path.join(qualDir, 'qualification-receipt.json'), 'utf8'));
assert.deepEqual(MEMO_STT_QUALIFICATION_RECEIPT, receipt, 'production receipt must equal the cleaned S24 capture');
assert.deepEqual(MEMO_STT_QUALIFICATION, {success:true,state:'qualified',receipt:'hs8-memo-stt-s24-20261017'});
assert.equal(Object.isFrozen(MEMO_STT_QUALIFICATION), true);
assert.equal(receipt.owner.promptSha256, crypto.createHash('sha256').update(MEMO_TRANSCRIPTION_PROMPT).digest('hex'));
for (const sample of receipt.samples) {
  const audio = fs.readFileSync(path.join(qualDir, sample.file));
  assert.equal(crypto.createHash('sha256').update(audio).digest('hex'), sample.sha256, sample.id);
  assert.equal(audio.length, sample.bytes); assert.equal(audio.subarray(8, 12).toString('latin1'), sample.majorBrand);
  assert.equal(isM4aContainer(audio), true); assert.equal(memoAudioDurationWithinLimit(audio), true);
}
// Any mismatch with the qualified owner keeps the input closed; no caller boolean can open it.
const refused = {success:false,state:'refused',receipt:null,error:'memo_stt_not_qualified'};
const clone = () => JSON.parse(JSON.stringify(receipt));
const variant = mutate => { const r = clone(); mutate(r); return qualifyMemoStt(r); };
assert.deepEqual(qualifyMemoStt(clone()), MEMO_STT_QUALIFICATION);
for (const forged of [undefined, null, true, {success:true}, {success:true,state:'qualified',receipt:'x'}, [], 'qualified', Object.create(receipt)]) assert.deepEqual(qualifyMemoStt(forged), refused);
for (const [label, mutate] of [
  ['schema', r => { r.schemaVersion = 2; }], ['kind', r => { r.kind = 'other'; }], ['id', r => { r.id = '../x'; }], ['date', r => { delete r.capturedAt; }],
  ['owner module', r => { r.owner.module = 'transcribeAudioFile'; }], ['sdk version', r => { r.owner.sdk.version = '2026.10.1'; }],
  ['sdk package', r => { r.owner.sdk.package = 'other'; }], ['provider', r => { r.owner.provider = 'openai'; }],
  ['model', r => { r.owner.model = 'gemini-3-flash-preview'; }], ['profile', r => { r.owner.profile = 'google:default'; }],
  ['prompt', r => { r.owner.promptSha256 = '0'.repeat(64); }], ['auth unlocked', r => { r.authPreflight.lockedProfile = false; }],
  ['auth profile', r => { r.authPreflight.profileId = 'google:other'; }], ['auth mode', r => { r.authPreflight.mode = 'oauth'; }],
  ['openai', r => { r.openaiCalled = true; }], ['writes', r => { r.runtimeWrites = 'config'; }], ['personal', r => { r.personalData = true; }],
  ['log privacy', r => { r.logPrivacy.transcriptOrAudioPathPersistedBySdk = true; }], ['no samples', r => { r.samples = []; }],
  ['no android container', r => { r.samples = r.samples.filter(x => x.majorBrand !== 'mp42'); }],
  ['no exact transcript', r => { r.samples = r.samples.filter(x => x.majorBrand === 'mp42'); }],
  ['failed run', r => { r.samples[0].runs[0].success = false; }], ['empty text', r => { r.samples[1].runs[0].text = ' . '; }],
  ['fallback provider', r => { r.samples[0].runs[1].attempts.push({provider:'openai',model:'gpt-4o-transcribe',outcome:'success'}); }],
  ['other model attempt', r => { r.samples[1].runs[0].attempts[0].model = 'gemini-3-flash-preview'; }],
  ['no attempts', r => { r.samples[1].runs[0].attempts = []; }], ['bad sha', r => { r.samples[0].sha256 = 'abc'; }],
  ['not audio', r => { r.samples[0].isM4aContainer = false; }], ['too long', r => { r.samples[0].durationWithinLimit = false; }],
]) assert.deepEqual(variant(mutate), refused, label);
const unavailable = memoSttOwnerFailure();
assert.deepEqual(memoSttOwnerFailure(new Error('synthetic private detail')), unavailable);
for (const value of [null, [], 'bonjour', {}, {text:null}, {text:''}, {text:' \n\t '}, {result:{text:'bonjour'}}, Object.create({text:'bonjour'})]) assert.deepEqual(projectMemoTranscript(value), unavailable);
let readPrivate = false;
const result = {text:'  Prépare la liste de courses.  '};
Object.defineProperty(result,'output',{get(){readPrivate=true; throw Error('never read');}});
Object.defineProperty(result,'decision',{get(){readPrivate=true; throw Error('never read');}});
assert.deepEqual(projectMemoTranscript(result), {success:true,state:'transcribed',text:'  Prépare la liste de courses.  '});
assert.equal(readPrivate, false);
assert.deepEqual(projectMemoTranscript({get text(){throw Error('private SDK exception');}}), unavailable);
assert.deepEqual(projectMemoTranscript(new Proxy({}, {getOwnPropertyDescriptor(){throw Error('private SDK exception');}})), unavailable);
for (const text of ['x'.repeat(12001), '\ud800', '\udfff', 'bonjour\u0000', 'bonjour\u202e', 'OTP : 1234', 'OTP : ١٢٣٤', 'PIN １２３４', 'PIN 123', 'code de vérification 4321', 'sk-proj-ABCDEFGHIJKLMNabcdefghijk', 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'AKIAABCDEFGHIJKLMNOP', 'eyJabc.payload.signature', 'password: syntheticValue', '-----BEGIN PRIVATE KEY-----\nQUJDREVG\n-----END PRIVATE KEY-----']) assert.deepEqual(projectMemoTranscript({text}), unavailable);
for (const text of ['موعد الطبيب غدا', 'Bonjour 😀', 'Code HTTP 404', 'Étape 2', 'Une ligne\nUne autre', 'paie la facture', 'recharge Orange 7 DT', '123456', 'owner@example.test', 'https://example.test', 'Appelle le 0612345678']) assert.deepEqual(projectMemoTranscript({text}), {success:true,state:'transcribed',text});
assert.equal(projectMemoTranscript({text:'a'.repeat(12000)}).success, true);
// Unbounded/private sibling data is neither traversed nor projected.
const large = {text:'Bonjour',output:Array.from({length:50000},()=>({private:'synthetic'}))};
const before = performance.now();
for (let i=0;i<1000;i++) assert.deepEqual(projectMemoTranscript(large), {success:true,state:'transcribed',text:'Bonjour'});
assert.ok(performance.now()-before<1000, 'pure projection regression budget: 1000 in 1s');
assert.equal(large.text, 'Bonjour');
assert.deepEqual(Object.keys(projectMemoTranscript(large)), ['success','state','text']);
console.log('HS8 memo STT: S24 receipt qualifies the canonical owner (exact model/profile/SDK/prompt, mp42, no fallback); forged or mismatched receipts refused; projection bounded');
