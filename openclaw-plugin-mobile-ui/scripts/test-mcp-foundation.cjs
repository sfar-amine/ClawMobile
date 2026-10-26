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
 assert.equal(JSON.parse(read.content).content,value.content);assert.equal(response.bundle.foundation.content,undefined,'foundation body delivered once, not duplicated');assert.equal(response.bundle.cursor_advanced,false);assert.equal(response.bundle.context_consumption.implicit_client_cursor,false);
 console.log('PASS MCP L2 foundation read hash, single body delivery, no implicit consumer acknowledgement');
}finally{os.homedir=home;if(previous===undefined)delete process.env.CLAW_UI_PLAYBOOKS_ROOT;else process.env.CLAW_UI_PLAYBOOKS_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
