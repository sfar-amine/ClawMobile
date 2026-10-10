const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'c6-context-')),oldRoot=process.env.CLAW_UI_PLAYBOOKS_ROOT;
fs.mkdirSync(path.join(root,'tools'));const calls=path.join(root,'calls.jsonl');
// Generated transport probe uses the existing reader's argv contract. It is not a S24 capture.
fs.writeFileSync(path.join(root,'tools/request_context.py'),`import sys,json,time\na=sys.argv[1:]\nopen(${JSON.stringify(calls)},'a').write(json.dumps(a)+'\\n')\nsurface=a[a.index('--surface')+1]\nscopes=a[a.index('--scopes')+1].split(',') if '--scopes' in a else []\nif 'unknown' in scopes: raise ValueError('unknown_rule_scope:unknown')\nprint(json.dumps({'surface':surface,'rule_scopes':scopes,'read_only':True,'cursor_advanced':False,'contracts':[],'global':{'read_required':False},'readiness':{'state':'ready','required_reads':[]}}))\n`);
process.env.CLAW_UI_PLAYBOOKS_ROOT=root;
const {handleMcpRelayRequest}=require('../dist/companion/mcpBridge');let id=0;
const captured=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/context/c6-context-provenance.json'))).response;
const invoke=(clientId,arguments={},profile='chat-owner')=>handleMcpRelayRequest({requestId:'c6-'+(++id),clientId,profile,tool:'claw_context',arguments:{query:'Fixture',...arguments}});
const readCalls=()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse):[];
(async()=>{try{
  assert.equal(captured._claw_access.client_id,'codex-cloud');assert.equal(captured.surface,'chat');
  const admitted=await invoke(captured._claw_access.client_id,{scopes:['engineering']},captured._claw_access.profile);
  assert.equal(admitted.bundle.surface,'codex');assert.ok(Object.hasOwn(captured.manifest.modules,'engineering'));
  for(const [clientId,surface] of [['codex-cloud','codex'],['codex.desktop','codex'],['claude-chat','claude'],['mobile-owner','app'],['bixby-owner','voice'],['unknown-client','chat'],['notcodex','chat']]){
    const result=await invoke(clientId,{scopes:['engineering','memory','engineering'],surface:'work',clientId:'other',profile:'owner'});
    assert.equal(result.bundle.surface,surface);assert.deepEqual(result.bundle.rule_scopes,['engineering','memory']);assert.equal(result.bundle.cursor_advanced,false);
  }
  const result=await invoke('claude-chat',{scopes:'memory, engineering',after_revision:12,uncertain:true,known_contracts:{'SOUL.md':'a'.repeat(64)}});
  assert.equal(result.bundle.surface,'claude');assert.deepEqual(result.bundle.rule_scopes,['memory','engineering']);
  const argv=readCalls().at(-1);assert.ok(argv.includes('--after'));assert.ok(argv.includes('--uncertain'));assert.ok(argv.includes('--known-contracts'));
  let before=readCalls().length;
  for(const scopes of [['--surface'],[['memory']],Array(17).fill('memory'),{memory:true},'x'.repeat(513)])await assert.rejects(invoke('codex-cloud',{scopes}),/invalid_scopes/);
  assert.equal(readCalls().length,before);
  const refused=await invoke('codex-cloud',{scopes:['memory']},'trusted');assert.equal(refused.error,'unsupported_profile');assert.equal(readCalls().length,before);
  await assert.rejects(invoke('codex-cloud',{scopes:['unknown']}),/unknown_rule_scope/);assert.equal(readCalls().length,before+1);
  console.log('C6 admitted identity provenance, scoped argv, pre-dispatch validation and no caller authority override passed');
}finally{if(oldRoot===undefined)delete process.env.CLAW_UI_PLAYBOOKS_ROOT;else process.env.CLAW_UI_PLAYBOOKS_ROOT=oldRoot;fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
