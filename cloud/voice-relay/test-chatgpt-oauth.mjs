import assert from 'node:assert/strict';
import { chatgptReadAllowed, chatgptGrant, chatgptProfile } from './src/chatgpt-oauth-policy.mjs';
import { consentPage } from './auth/consent.mjs';
const owner = 'verified-owner';
assert.equal(chatgptReadAllowed({scope:['mcp:read']},{userId:owner},owner),true);
for(const [auth,props,subject] of [
  [null,null,owner], [{scope:['mcp:read']},{userId:'attacker'},owner],
  [{scope:['mcp:write']},{userId:owner},owner],
  [{scope:['mcp:read']},{userId:owner},''],
  [{scope:'mcp:read'},{userId:owner},owner],
]) assert.equal(chatgptReadAllowed(auth,props,subject),false);
console.log('ChatGPT OAuth owner/read policy: PASS (6 cases)');
assert.deepEqual(chatgptGrant('read'), {scope:['mcp:read'],access:'read',ownerConsentVersion:0});
assert.deepEqual(chatgptGrant('owner'), {scope:['mcp:read','mcp:owner'],access:'owner',ownerConsentVersion:1});
assert.throws(()=>chatgptGrant('admin'), /invalid_consent_access/);
const read = {scope:['mcp:read']};
const full = {scope:['mcp:read','mcp:owner']};
const props = {userId:owner,access:'owner',ownerConsentVersion:1};
assert.equal(chatgptProfile(read,{userId:owner},owner),'chat-owner-shadow');
assert.equal(chatgptProfile(full,props,owner),'chat-owner');
for(const [auth,p,subject] of [
  [full,{userId:owner},owner], [read,props,owner],
  [full,{...props,ownerConsentVersion:0},owner], [full,props,'other-owner'],
  [{scope:['mcp:owner']},props,owner], [null,null,owner],
]) assert.equal(chatgptProfile(auth,p,subject),null);
const page=consentPage({scope:['mcp:read'],clientName:'<untrusted>',redirectHost:'example.test',clientDomain:'client.test'},'synthetic-handle');
assert.ok(page.includes('value="read" checked'));
assert.ok(page.includes('value="owner"'));
assert.ok(page.includes('&#60;untrusted&#62;'));
assert.ok(!page.includes('<untrusted>'));
assert.ok(page.includes('biométrie, OTP et banque'));
console.log('Explicit owner grant, legacy read protection and consent: PASS (16 assertions)');
