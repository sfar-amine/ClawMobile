const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MEMO_STT_QUALIFICATION, memoSttOwnerFailure, projectMemoTranscript } = require('../dist/companion/memoSttBoundary');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-11/hs8/sdk-exports.json'), 'utf8'));
assert.equal(fixture.provenance.state, 'completed');
assert.equal(fixture.provenance.exitCode, 0);
assert.equal(fixture.exports.version, '2026.9.6');
for (const key of ['publicExport','transcribeAudioFileExported','transcribeSignaturePresent','runMediaUnderstandingFileExported','loadConfigExported']) assert.equal(fixture.exports[key], true);
for (const key of ['provider','audioFixture','globalDeadline','sdkLogPrivacy']) assert.equal(fixture.qualification[key], false);
// The real export probe never enables admission, even if a caller passes a
// forged qualification or a provider shaped object. No SDK/fetch is imported.
assert.deepEqual(MEMO_STT_QUALIFICATION, {success:false,state:'refused',receipt:null,error:'memo_stt_not_qualified'});
assert.equal(Object.isFrozen(MEMO_STT_QUALIFICATION), true);
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
console.log('HS8 memo STT preparation: installed export proof + closed projection passed; admission remains refused (no provider qualification)');
