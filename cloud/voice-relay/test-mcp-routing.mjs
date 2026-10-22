import assert from 'node:assert/strict';
import { useLegacyMcpAuth } from './src/mcp-routing.mjs';
assert.equal(useLegacyMcpAuth({ok:true,clientId:'claude-chat',profile:'chat-owner'}),true);
assert.equal(useLegacyMcpAuth({ok:true,clientId:'codex-cloud',profile:'chat-owner-shadow'}),true);
for (const bad of [null,{ok:false},{ok:true,clientId:'chatgpt',profile:'unknown'},{ok:true,profile:'chat-owner'}]) assert.equal(useLegacyMcpAuth(bad),false);
console.log('MCP legacy routing: PASS (6 cases)');
