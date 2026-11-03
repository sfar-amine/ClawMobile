const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

// Exercise the private startup owner without opening a listener or launching runtime services.
// The closed maintenance outcomes are synthetic, not a new S24 qualification receipt.
const text=fs.readFileSync(path.join(__dirname,'../src/companion/server.ts'),'utf8');
const source=ts.createSourceFile('server.ts',text,ts.ScriptTarget.Latest,true);
function declaration(name){
  const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert.ok(node,name);return node;
}
const helper=declaration('maintainRemoteBridgeReadReceipts');
const diagnostic=declaration('serverDiagnostic');
const startup=declaration('startCompanionServer');
const callbacks=[];
function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='setTimeout'&&
      node.arguments[0]?.getText(source).includes('abandonStaleRemoteBridgeReceipts'))callbacks.push(node);
  ts.forEachChild(node,visit);
}
visit(startup);
assert.equal(callbacks.length,1,'reuse the existing F6 startup pass');
const callback=callbacks[0].arguments[0].getText(source);
assert.ok(callback.indexOf('maintainRemoteBridgeReadReceipts()')>callback.indexOf('abandonStaleRemoteBridgeReceipts('));
assert.doesNotMatch(helper.getText(source),/set(?:Timeout|Interval)|submitRemoteBridgeRequest/);
const lines=[];let calls=0;let failure=false;
const context={process:{env:{}},console:{log:line=>lines.push(line)},module:{exports:{}},
  pruneRemoteBridgeReadReceipts:async()=>{
    calls++;
    if(failure)throw Error('PRIVATE_TOKEN private@example.invalid /private/receipt.json');
    return {state:'applied',scanned:50003,removed:3,preserved:5,retainedRead:50000,
      requestId:'PRIVATE_REQUEST',path:'/private/receipt.json'};
  }};
const js=ts.transpileModule(diagnostic.getText(source)+'\n'+helper.getText(source),
  {compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
vm.runInNewContext(js+'\nmodule.exports=maintainRemoteBridgeReadReceipts;',context);
(async()=>{
  for(const value of [undefined,'0','true','01',' 1','1 ']){
    if(value===undefined)delete context.process.env.CLAWMOBILE_REMOTE_BRIDGE_READ_RETENTION;
    else context.process.env.CLAWMOBILE_REMOTE_BRIDGE_READ_RETENTION=value;
    await context.module.exports();
  }
  assert.equal(calls,0);assert.deepEqual(lines,[]);
  context.process.env.CLAWMOBILE_REMOTE_BRIDGE_READ_RETENTION='1';
  await context.module.exports();
  assert.equal(calls,1);
  assert.equal(lines[0],'component=companion level=info event=remote_bridge_read_retention scanned=50003 removed=3 preserved=5 retainedRead=50000 state=applied');
  failure=true;await context.module.exports();
  assert.equal(lines[1],'component=companion level=warn event=remote_bridge_read_retention_unavailable');
  assert.doesNotMatch(lines.join('\n'),/PRIVATE|@|\/private/);
  context.console.log=()=>{throw Error('sink unavailable')};await context.module.exports();
  console.log('Remote Bridge retention startup: exact opt-in, existing timer, closed outcomes and sink failures verified; no S24 qualification.');
})().catch(error=>{console.error(error);process.exitCode=1;});
