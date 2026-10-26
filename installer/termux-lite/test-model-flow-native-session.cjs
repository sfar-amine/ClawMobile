// Actual captured SDK async/transaction/CAS functions over explicitly authored
// minimal SQLite I/O ports. No S24 database, plugin runtime or model is executed.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../openclaw-plugin-mobile-ui/fixtures/s24-2026-10-25-model-flow-sdk');
const provenance=require(path.join(root,'PROVENANCE.json'));
const snippets=require(path.join(root,'native-session-cas-snippets.json'));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function snippet(module,name){const m=snippets.files.find(x=>x.module===module),s=m.snippets.find(x=>x.name===name);assert.equal(sha(s.source),s.snippet_sha256);return s.source;}
const source=fs.readFileSync(path.join(root,'session-accessor.sqlite-entry-UCl9kr-O.mjs'),'utf8');
assert.equal(sha(source),provenance.files.find(x=>x.module==='session-accessor.sqlite-entry-UCl9kr-O.mjs').sha256);
function captured(begin,end){const start=source.indexOf(begin),finish=source.indexOf(end,start);assert.ok(start>=0&&finish>start);return source.slice(start,finish);}
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'model-profile-cas-')),file=path.join(directory,'authored.sqlite');
const db=new DatabaseSync(file);db.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)');
const database={db,path:file,agentId:'main'},clone=x=>JSON.parse(JSON.stringify(x));
const readRows=keys=>{const rows=db.prepare('SELECT * FROM session_nodes ORDER BY session_key').all();return keys?rows.filter(r=>keys.includes(r.session_key)):rows;};
function snapshot(key){const rows=readRows([key]);return rows.map(r=>({sessionKey:r.session_key,entry:JSON.parse(r.entry_json),persistedRows:{lookupKeys:[key],rows:readRows([key])}}));}
let writeCount=0,transactionCount=0;
const context={process,Map,Error,JSON,Promise,structuredClone,
 cloneEnvWithPlatformSemantics:clone,resolveStateDir:()=>directory,toDatabaseOptions:x=>x,resolveOpenClawAgentSqlitePath:()=>file,
 isIncognitoOpenClawAgentSqlitePath:()=>false,getOpenClawAgentDatabaseIfOpen:()=>database,
 openOpenClawAgentDatabase:()=>database,runExclusiveSqliteSessionWrite:(_scope,op)=>op(),
 cloneSessionEntry:clone,mergeSessionEntry:(entry,patch)=>({...entry,...patch}),mergeSessionEntryPreserveActivity:(entry,patch)=>({...entry,...patch}),
 preserveSqliteSameKeySessionRolloverLineage:({next})=>next,prepareSessionIdentityPublication:()=>undefined,
 kickSessionEntryMaintenanceAfterWrite(){},kickSessionHistoryDiskBudgetMaintenance(){},resolveSqliteTranscriptArchiveDirectory:()=>directory,
 assertAgentDeletionDatabaseCleanupAccess(){},ensureOpenClawAgentDatabasePermissions(){},getAgentDeletionDatabaseCleanup:()=>undefined,
 cache:{incognito:new Set()},withSqlitePostCommitPublications:(_db,op)=>op(),
 runSqliteImmediateTransactionSync:(connection,op)=>{transactionCount++;connection.exec('BEGIN IMMEDIATE');try{const result=op();connection.exec('COMMIT');return result;}catch(e){connection.exec('ROLLBACK');throw e;}},
 isDeepStrictEqual:require('node:util').isDeepStrictEqual,
 sqliteStringSet:keys=>keys,executeSqliteQuerySync:(_db,query)=>({rows:readRows(query.keys)}),
 getSessionKysely:()=>({selectFrom:()=>({selectAll:()=>({where:(_field,_op,keys)=>({orderBy:()=>({keys})})})})}),
 writeSessionEntry:(_database,key,entry)=>{writeCount++;db.prepare('UPDATE session_nodes SET entry_json=? WHERE session_key=?').run(JSON.stringify(entry),key);return entry;}
};
const program=[snippet('session-accessor.sqlite-entry-store-DTntRuil.mjs','equality-region'),
 snippet('session-accessor.sqlite-entry-store-DTntRuil.mjs','readUnchangedLifecycleTargetSnapshot'),
 captured('function applySessionEntryPatchInDatabase(', '//#endregion\n//#region src/config/sessions/session-accessor.sqlite-history.ts'),
 snippet('openclaw-agent-db-CaQAStOA.mjs','runOpenClawAgentWriteTransaction'),
 captured('async function patchSqliteSessionEntrySnapshot(', 'async function recordInboundSessionMeta('),
 '\n({patchSqliteSessionEntrySnapshot})'].join('\n');
const native=vm.runInNewContext(program,context);
function seed(key,entry){db.prepare('INSERT OR REPLACE INTO session_nodes VALUES(?,?)').run(key,JSON.stringify(entry));}
function row(key){return JSON.parse(db.prepare('SELECT entry_json FROM session_nodes WHERE session_key=?').get(key).entry_json);}
function patch(key,update){return native.patchSqliteSessionEntrySnapshot({sessionKey:key,resolved:{agentId:'main',env:{}},readSnapshot:()=>snapshot(key),update,options:{preserveActivity:true,skipMaintenance:true,requireWriteSuccess:true},operationLabel:'authored-model-profile'});}
function foreignWrite(key,entry){
 // A distinct process, not a shared Map or the SDK's process-local mutex.
 const code="const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.prepare('UPDATE session_nodes SET entry_json=? WHERE session_key=?').run(process.argv[3],process.argv[2]);d.close();";
 execFileSync(process.execPath,['-e',code,file,key,JSON.stringify(entry)],{stdio:['ignore','pipe','pipe']});
}
(async()=>{
 try{
  const key='agent:main:authored-session',original={sessionId:'authored-generation',lifecycleRevision:3,updatedAt:123,pluginExtensions:{other:{retain:true}}};seed(key,original);
  const saved=await patch(key,fresh=>({pluginExtensions:{...fresh.pluginExtensions,profile:{version:1,model:'openai/authored'}}}));
  assert.equal(saved.updatedAt,123);assert.deepEqual(saved.pluginExtensions.other,{retain:true});assert.equal(writeCount,1);
  const old=clone(row(key)),beforeWrites=writeCount;
  await assert.rejects(patch(key,async fresh=>{
   foreignWrite(key,{...fresh,sessionId:'new-generation',lifecycleRevision:4});
   return {pluginExtensions:{...fresh.pluginExtensions,stale:{mustNotPersist:true}}};
  }),/SQLite session state changed/);
  assert.equal(writeCount,beforeWrites);assert.equal(row(key).sessionId,'new-generation');assert.equal(row(key).pluginExtensions.stale,undefined);
  seed(key,old);
  await assert.rejects(patch(key,async fresh=>{
   foreignWrite(key,{...fresh,pluginExtensions:{...fresh.pluginExtensions,concurrent:{retain:true}}});
   return {pluginExtensions:{...fresh.pluginExtensions,stale:{mustNotPersist:true}}};
  }),/SQLite session state changed/);
  assert.equal(row(key).pluginExtensions.concurrent.retain,true);assert.equal(row(key).pluginExtensions.stale,undefined);
  assert.equal(writeCount,beforeWrites,'SDK rechecks the complete prepared entry, including same-generation concurrent metadata');
  const unchanged=row(key);await patch(key,()=>null);assert.deepEqual(row(key),unchanged);assert.equal(writeCount,beforeWrites);
  const started=Date.now();
  for(let i=0;i<451;i++){
   const k='agent:main:authored-volume-'+i;seed(k,{...original,sessionId:'authored-volume-'+i});
   await patch(k,fresh=>({pluginExtensions:{...fresh.pluginExtensions,profile:{version:1,model:'openai/authored'}}}));
  }
  assert.ok(Date.now()-started<25000,'451 real SQLite metadata writes exceed the existing preparation budget');
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_nodes').get().n,452);
  assert.equal(transactionCount,455);assert.equal(writeCount,452);
  console.log('Native SDK functions + authored SQLite I/O PASS: async preparation, separate-process reset and metadata conflict, exact rollback/no stale write, preserved activity,451 rows; no S24 database or model call.');
 }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
