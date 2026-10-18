const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const {createHash}=require('node:crypto');
const {spawnSync} = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samantha-run-diagnostics-'));
process.env.OPENCLAW_STATE_DIR = root;
const folder = path.join(root, 'clawmobile-companion');
fs.mkdirSync(folder);
const file = path.join(folder, 'runs.json');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/s24-2026-10-11c/hs5-runs-shapes.json')));
assert.match(fixture.provenance.device, /S24/);
const api = require('../dist/companion/runs');
const attachmentOwner = require('../dist/companion/attachmentStorage');
const originalRemove = attachmentOwner.removeAttachments;
const originalError = console.error;
const originalLog = console.log;
const lines = [];
console.log = (...values) => lines.push(values.join(' '));
let passed = 0;
async function check(body) { await body(); passed++; }
const PRIVATE = 'PRIVATE_ACCOUNT@example.invalid Bearer PRIVATE_TOKEN request=PRIVATE_REQUEST';
function write(records, runDeletions = []) {
  fs.writeFileSync(file, JSON.stringify({version: 1, runs: records, archivedSessionIds: [],
    paymentRequests: [], ownerConfirmations: [], runDeletions}));
}
function record(id, extra = {}) {
  // Source shape is the sanitized S24 capture; absolute time and missing private fields are test-only.
  return {...fixture.runs[0], runId: id, clientRunId: 'client_' + id, sessionId: 'diagnostic-test',
    acceptedAt: Date.now(), updatedAt: Date.now(), text: PRIVATE, userText: PRIVATE, ...extra};
}
function decoded(line) {
  assert.match(line, /^component=runs level=(?:warn|error) event=[a-z_]+(?: [A-Za-z]+=[A-Za-z0-9_-]+)*$/);
  const tokens = Object.fromEntries(line.split(' ').map(field => field.split('=')));
  const {component,level,event,...fields} = tokens;
  if (fields.count !== undefined) fields.count=Number(fields.count);
  return {level,fields,code:event};
}
(async () => {
  await check(async () => {
    const rows = fixture.runs.map((row, i) => record(row.runId, {reasonClass: 'transport_timeout'}));
    write(rows);
    for (const row of rows) await api.markSubmittedRunFailed(row.runId, PRIVATE);
    const events = lines.map(decoded).filter(row => row.code === 'submitted_run_failed');
    assert.equal(events.length, rows.length);
    assert.deepEqual(events.map(row => row.fields.runId), rows.map(row => row.runId));
    for (const event of events) {
      assert.equal(event.level, 'error');
      assert.equal(event.fields.clientRunId, 'client_' + event.fields.runId);
      assert.equal(event.fields.reasonClass, 'transport_timeout');
    }
    const stored = JSON.parse(fs.readFileSync(file));
    for (const row of stored.runs) { assert.equal(row.state, 'failed'); assert.equal(row.error, PRIVATE); }
    assert.doesNotMatch(lines.join('\n'), /PRIVATE|Bearer|@|request=/);
  });
  await check(async () => {
    write([record('run_corrupt_receipts')], [{error: PRIVATE}, PRIVATE]);
    await api.markSubmittedRunFailed('run_corrupt_receipts', PRIVATE);
    const events = lines.map(decoded).filter(row => row.code === 'invalid_run_deletion_receipts_ignored');
    assert.ok(events.length > 0);
    for (const event of events) assert.deepEqual(event, {level:'warn',fields:{count:2},code:'invalid_run_deletion_receipts_ignored'});
  });
  await check(async () => {
    const row = record('run_memo_cleanup', {state:'running', attachments:[{serverPath:'/private/PRIVATE_AUDIO.m4a'}],
      memo:{attachmentId:'memo_fixture',phase:'ready',ownerEpoch:'00000000-0000-4000-8000-000000000001',attempts:1}});
    write([row]);
    attachmentOwner.removeAttachments = () => { throw Error(PRIVATE); };
    try { assert.equal(await api.claimMemoDispatch(row.runId, row.text, 'gateway', undefined, undefined, () => true), true); }
    finally { attachmentOwner.removeAttachments = originalRemove; }
    const event = lines.map(decoded).find(row => row.code === 'memo_attachment_cleanup_unavailable');
    assert.ok(event);assert.equal(event.fields.runId, row.runId);
    assert.equal(JSON.parse(fs.readFileSync(file)).runs[0].memo.phase, 'dispatched');
    assert.doesNotMatch(lines.join('\n'), /PRIVATE|Bearer|@/);
  });
  await check(async () => {
    const row = record('sk-private-token', {clientRunId:'ghp_private_token',reasonClass:PRIVATE});
    write([row]);await api.markSubmittedRunFailed(row.runId, PRIVATE);
    const event = decoded(lines.at(-1));assert.deepEqual(event.fields, {});
    assert.doesNotMatch(lines.join('\n'), /sk-private-token|ghp_private_token|PRIVATE/);
  });
  await check(async () => {
    const row = record('r'.repeat(160), {clientRunId:'c'.repeat(160),reasonClass:'r'.repeat(96)});
    write([row]);await api.markSubmittedRunFailed(row.runId, PRIVATE);
    const line = lines.at(-1);assert.ok(Buffer.byteLength(line) <= 600);
    const event = decoded(line);assert.equal(event.fields.runId.length,160);assert.equal(event.fields.clientRunId.length,160);
    assert.equal(event.fields.reasonClass.length,96);
  });
  await check(async () => {
    const row = record('r'.repeat(161), {clientRunId:'c'.repeat(161)});
    write([row]);await api.markSubmittedRunFailed(row.runId, PRIVATE);
    assert.deepEqual(decoded(lines.at(-1)).fields, {});
    const before = lines.length;await api.markSubmittedRunFailed('unknown_run_id',PRIVATE);assert.equal(lines.length,before);
  });
  await check(async () => {
    write([record('run_sink_unavailable')]);
    console.log = () => { throw Error('sink unavailable'); };
    try { await api.markSubmittedRunFailed('run_sink_unavailable', PRIVATE); }
    finally { console.log = (...values) => lines.push(values.join(' ')); }
    assert.equal(JSON.parse(fs.readFileSync(file)).runs[0].state, 'failed');
  });
  await check(() => {
    // Scope intentionally excludes Claude's live voice and mixed server bootstrap modules.
    for (const name of ['runs.ts','runWeb.ts','intent.ts']) {
      const text = fs.readFileSync(path.join(__dirname,'../src/companion',name),'utf8');
      const source = ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);
      let calls = 0;
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.expression.getText(source)==='console'
            && (['warn','error'].includes(node.expression.name.text) || name==='runs.ts' && node.expression.name.text==='log')) {
          calls++;
          let owner = node.parent;
          while (owner && !ts.isFunctionDeclaration(owner)) owner=owner.parent;
          assert.equal(owner?.name?.text,'runDiagnostic',name+' must not introduce free diagnostic console calls');
          assert.equal(node.expression.name.text,'log');
        }
        ts.forEachChild(node,visit);
      }
      visit(source);assert.equal(calls,name==='runs.ts'?1:0);
    }
  });
  await check(() => {
    // Replay a line ACTUALLY emitted above through the existing trace reader, not a reconstructed lookalike.
    const home=path.join(root,'trace-home'),health=path.join(home,'.openclaw/health');
    fs.mkdirSync(health,{recursive:true});
    const emitted=lines.find(line=>decoded(line).code==='submitted_run_failed');
    assert.ok(emitted);
    fs.writeFileSync(path.join(health,'companion.stderr.log'),'2026-10-18T10:00:00Z '+emitted+'\n');
    const done=spawnSync('python3',[path.join(__dirname,'../../installer/termux-lite/claw-trace.py'),
      '--since','2026-10-18T09:59:00Z','--until','2026-10-18T10:01:00Z','--no-app','--json'],
      {env:{...process.env,HOME:home},encoding:'utf8'});
    assert.equal(done.status,0,done.stderr);
    const events=done.stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(events.length,1);assert.equal(events[0].source,'companion');
    assert.equal(events[0].text,emitted);
  });
  let serverLines=[];
  await check(() => {
    // Extract the PRIVATE pure projection without importing server.ts and starting its runtime owners.
    const text=fs.readFileSync(path.join(__dirname,'../src/companion/server.ts'),'utf8');
    const source=ts.createSourceFile('server.ts',text,ts.ScriptTarget.Latest,true);
    const helper=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='serverDiagnostic');
    assert.ok(helper);
    const js=ts.transpileModule(helper.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
    const context={console:{log:(line)=>serverLines.push(line)},module:{exports:{}}};
    vm.runInNewContext(js+'\nmodule.exports=serverDiagnostic;',context);
    const project=context.module.exports;
    project('error','server_start_failed',{errno:'EADDRINUSE',message:PRIVATE,port:8765});
    project('warn','remote_bridge_abandon_sweep_unavailable',{errno:PRIVATE,message:PRIVATE});
    project('info','remote_bridge_abandon_sweep',{state:'complete',scanned:100,abandoned:2,uncertain:1});
    project('info','server_listening',{port:'PRIVATE',state:PRIVATE,scanned:-1,abandoned:Infinity,uncertain:Number.MAX_SAFE_INTEGER+1});
    assert.match(serverLines[0],/^component=companion level=error event=server_start_failed port=8765 errno=EADDRINUSE$/);
    assert.match(serverLines[1],/errno=unknown$/);
    assert.match(serverLines[2],/scanned=100 abandoned=2 uncertain=1 state=complete$/);
    assert.equal(serverLines[3],'component=companion level=info event=server_listening');
    assert.doesNotMatch(serverLines.join('\n'),/PRIVATE|Bearer|@|Infinity/);
    assert.ok(serverLines.every(line=>Buffer.byteLength(line)<=512));
    context.console.log=()=>{throw Error('sink unavailable')};assert.doesNotThrow(()=>project('info','server_shutdown'));
  });
  await check(() => {
    const home=path.join(root,'server-trace-home'),health=path.join(home,'.openclaw/health');
    fs.mkdirSync(health,{recursive:true});
    fs.writeFileSync(path.join(health,'companion.stderr.log'),serverLines.map(line=>'2026-10-18T10:00:00Z '+line).join('\n')+'\n');
    const done=spawnSync('python3',[path.join(__dirname,'../../installer/termux-lite/claw-trace.py'),
      '--since','2026-10-18T09:59:00Z','--until','2026-10-18T10:01:00Z','--no-app','--json'],
      {env:{...process.env,HOME:home},encoding:'utf8'});
    assert.equal(done.status,0,done.stderr);
    assert.deepEqual(done.stdout.trim().split('\n').map(line=>JSON.parse(line).text),serverLines);
  });
  await check(() => {
    const text=fs.readFileSync(path.join(__dirname,'../src/companion/server.ts'),'utf8');
    const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/foundations/f3-excluded-server-regions.json')));
    for (const region of fixture.regions) {
      const start=text.indexOf(region.start),end=text.indexOf(region.end,start+region.start.length);
      assert.ok(start>=0&&end>start);
      assert.equal(createHash('sha256').update(text.slice(start,end)).digest('hex'),region.sha256,
        region.name+' must remain byte-identical to the explicitly excluded source scope');
    }
  });
  originalLog(JSON.stringify({suite:'run-owner-diagnostics',passed,total:12,voiceScope:'excluded'}));
})().catch(error => { originalError(error); process.exitCode=1; }).finally(() => {
  console.error=originalError;console.log=originalLog;attachmentOwner.removeAttachments=originalRemove;
  fs.rmSync(root,{recursive:true,force:true});
});
