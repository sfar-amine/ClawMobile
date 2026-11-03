// Synthetic transport envelope over the same bounded L2 producer contract. No native state or model call.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-foundation-'));const home=os.homedir,previous=process.env.CLAW_UI_PLAYBOOKS_ROOT;
const pb=path.join(root,'.openclaw/workspace/ui-playbooks');fs.mkdirSync(path.join(pb,'tools'),{recursive:true});
const value={version:1,sha256:'a'.repeat(64),stable_sha256:'b'.repeat(64),revision:3239,content:'Authored foundation transport sentinel.',skills:[],sources:{},instruction:'No startup reread.',estimated_tokens:100,read_required:true};
fs.writeFileSync(path.join(pb,'tools/request_context.py'),`import json\nprint(json.dumps(${JSON.stringify({version:2,contracts:[],foundation:value,global:{read_required:false},context:{toRevision:3239,events:[]},readiness:{required_reads:['context/FOUNDATION']}}).replace(/true/g,'True').replace(/false/g,'False')}))\n`);
os.homedir=()=>root;process.env.CLAW_UI_PLAYBOOKS_ROOT=pb;
const {handleMcpRelayRequest}=require('../dist/companion/mcpBridge');
(async()=>{try{
 const response=await handleMcpRelayRequest({requestId:'foundation-transport',clientId:'chatgpt',profile:'chat-owner-shadow',tool:'claw_context',arguments:{query:'L2'}});
 assert.equal(response.required_reads.length,1);const read=response.required_reads[0];assert.equal(read.key,'context/FOUNDATION');assert.equal(read.sha256,crypto.createHash('sha256').update(read.content).digest('hex'));
 assert.equal(read.content,value.content);assert.equal(response.bundle.foundation.content,undefined,'foundation body delivered once, not duplicated');
 assert.deepEqual(response.bundle.foundation.skills,value.skills,'the complete skill index remains visible without double-encoding the body');
 assert.equal(response.bundle.foundation.stable_sha256,value.stable_sha256);assert.equal(response.bundle.foundation.revision,value.revision);
 assert.equal(response.bundle.foundation.sources,undefined,'per-source diagnostic hashes remain bound by the aggregate fingerprint');
 assert.equal(response.bundle.cursor_advanced,false);assert.equal(response.bundle.context_consumption.implicit_client_cursor,false);
 // Authored oversized transport with a misleading producer estimate must still fail before delivery.
 // S24 28/10: a 6171-token foundation (about 24.7 kB) was refused at the former 24000-byte limit.
 const s24={...value,content:'x'.repeat(24700)};
 fs.writeFileSync(path.join(pb,'tools/request_context.py'),`import json\nprint(json.dumps(${JSON.stringify({version:2,contracts:[],foundation:s24,global:{read_required:false},context:{toRevision:3239,events:[]},readiness:{required_reads:['context/FOUNDATION']}}).replace(/true/g,'True').replace(/false/g,'False')}))\n`);
 assert.equal((await handleMcpRelayRequest({requestId:'foundation-s24-size',clientId:'chatgpt',profile:'chat-owner-shadow',tool:'claw_context',arguments:{query:'L2'}})).required_reads[0].content.length,24700);
 const oversized={...value,content:'x'.repeat(32001)};
 fs.writeFileSync(path.join(pb,'tools/request_context.py'),`import json\nprint(json.dumps(${JSON.stringify({version:2,contracts:[],foundation:oversized,global:{read_required:false},context:{toRevision:3239,events:[]},readiness:{required_reads:['context/FOUNDATION']}}).replace(/true/g,'True').replace(/false/g,'False')}))\n`);
 await assert.rejects(handleMcpRelayRequest({requestId:'foundation-overflow',clientId:'chatgpt',profile:'chat-owner-shadow',tool:'claw_context',arguments:{query:'L2'}}),/foundation_mcp_response_budget_exceeded/);
 const missing={...value};delete missing.content;
 fs.writeFileSync(path.join(pb,'tools/request_context.py'),`import json\nprint(json.dumps(${JSON.stringify({version:2,contracts:[],foundation:missing,global:{read_required:false},context:{toRevision:3239,events:[]},readiness:{required_reads:['context/FOUNDATION']}}).replace(/true/g,'True').replace(/false/g,'False')}))\n`);
 await assert.rejects(handleMcpRelayRequest({requestId:'foundation-missing-body',clientId:'chatgpt',profile:'chat-owner-shadow',tool:'claw_context',arguments:{query:'L2'}}),/foundation_mcp_content_required/);
 console.log('PASS MCP L2 foundation read hash, single body delivery, no implicit consumer acknowledgement');
}finally{os.homedir=home;if(previous===undefined)delete process.env.CLAW_UI_PLAYBOOKS_ROOT;else process.env.CLAW_UI_PLAYBOOKS_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
