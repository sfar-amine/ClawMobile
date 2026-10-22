import assert from 'node:assert/strict';
import { chatgptReadAllowed } from './src/chatgpt-oauth-policy.mjs';
const owner = 'verified-owner';
assert.equal(chatgptReadAllowed({scope:['mcp:read']},{userId:owner},owner),true);
for(const [auth,props,subject] of [
  [null,null,owner], [{scope:['mcp:read']},{userId:'attacker'},owner],
  [{scope:['mcp:write']},{userId:owner},owner],
  [{scope:['mcp:read']},{userId:owner},''],
  [{scope:'mcp:read'},{userId:owner},owner],
]) assert.equal(chatgptReadAllowed(auth,props,subject),false);
console.log('ChatGPT OAuth owner/read policy: PASS (6 cases)');
