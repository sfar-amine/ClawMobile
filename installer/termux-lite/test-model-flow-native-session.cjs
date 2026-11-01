// Actual SDK async/transaction/CAS functions over explicitly authored minimal SQLite I/O ports, per pinned version:
//   node test-model-flow-native-session.cjs            -> 2026.9.6 (S24 capture of 25-26/10, unchanged)
//   node test-model-flow-native-session.cjs 2026.10.9  -> upgrade candidate (public npm functions)
// No S24 database, plugin runtime or model is executed.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{execFileSync}=require('node:child_process');
const {selectedVersion,fixtures}=require('./model-flow-sdk-fixtures.cjs');
const version=selectedVersion();
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'model-profile-cas-')),file=path.join(directory,'authored.sqlite');
const db=new DatabaseSync(file);db.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)');
const readRowsOn=(connection,keys)=>{const rows=connection.prepare('SELECT * FROM session_nodes ORDER BY session_key').all();return keys?rows.filter(r=>keys.includes(r.session_key)):rows;};
const readRows=keys=>readRowsOn(db,keys);
function seed(key,entry){db.prepare('INSERT OR REPLACE INTO session_nodes VALUES(?,?)').run(key,JSON.stringify(entry));}
function row(key){return JSON.parse(db.prepare('SELECT entry_json FROM session_nodes WHERE session_key=?').get(key).entry_json);}
function foreignWrite(key,entry){
 // A distinct process, not a shared Map or the SDK's process-local mutex.
 const code="const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.prepare('UPDATE session_nodes SET entry_json=? WHERE session_key=?').run(process.argv[3],process.argv[2]);d.close();";
 execFileSync(process.execPath,['-e',code,file,key,JSON.stringify(entry)],{stdio:['ignore','pipe','pipe']});
}
const counters={writes:0,transactions:0,workerCommits:0,directCommits:0};
const PROFILE_OPTIONS={preserveActivity:true,skipMaintenance:true,requireWriteSuccess:true};

// 2026.9.6: internal patchSqliteSessionEntrySnapshot captured on the S24 (unchanged since 26/10).
function build96(){
 const root=path.join(fixtures,'s24-2026-10-25-model-flow-sdk');
 const provenance=require(path.join(root,'PROVENANCE.json'));
 const snippets=require(path.join(root,'native-session-cas-snippets.json'));
 function snippet(module,name){const m=snippets.files.find(x=>x.module===module),s=m.snippets.find(x=>x.name===name);assert.equal(sha(s.source),s.snippet_sha256);return s.source;}
 const source=fs.readFileSync(path.join(root,'session-accessor.sqlite-entry-UCl9kr-O.mjs'),'utf8');
 assert.equal(sha(source),provenance.files.find(x=>x.module==='session-accessor.sqlite-entry-UCl9kr-O.mjs').sha256);
 function captured(begin,end){const start=source.indexOf(begin),finish=source.indexOf(end,start);assert.ok(start>=0&&finish>start);return source.slice(start,finish);}
 const database={db,path:file,agentId:'main'};
 function snapshot(key){const rows=readRows([key]);return rows.map(r=>({sessionKey:r.session_key,entry:JSON.parse(r.entry_json),persistedRows:{lookupKeys:[key],rows:readRows([key])}}));}
 const context={process,Map,Error,JSON,Promise,structuredClone,
  cloneEnvWithPlatformSemantics:clone,resolveStateDir:()=>directory,toDatabaseOptions:x=>x,resolveOpenClawAgentSqlitePath:()=>file,
  isIncognitoOpenClawAgentSqlitePath:()=>false,getOpenClawAgentDatabaseIfOpen:()=>database,
  openOpenClawAgentDatabase:()=>database,runExclusiveSqliteSessionWrite:(_scope,op)=>op(),
  cloneSessionEntry:clone,mergeSessionEntry:(entry,patch)=>({...entry,...patch}),mergeSessionEntryPreserveActivity:(entry,patch)=>({...entry,...patch}),
  preserveSqliteSameKeySessionRolloverLineage:({next})=>next,prepareSessionIdentityPublication:()=>undefined,
  kickSessionEntryMaintenanceAfterWrite(){},kickSessionHistoryDiskBudgetMaintenance(){},resolveSqliteTranscriptArchiveDirectory:()=>directory,
  assertAgentDeletionDatabaseCleanupAccess(){},ensureOpenClawAgentDatabasePermissions(){},getAgentDeletionDatabaseCleanup:()=>undefined,
  cache:{incognito:new Set()},withSqlitePostCommitPublications:(_db,op)=>op(),
  runSqliteImmediateTransactionSync:(connection,op)=>{counters.transactions++;connection.exec('BEGIN IMMEDIATE');try{const result=op();connection.exec('COMMIT');return result;}catch(e){connection.exec('ROLLBACK');throw e;}},
  isDeepStrictEqual:require('node:util').isDeepStrictEqual,
  sqliteStringSet:keys=>keys,executeSqliteQuerySync:(_db,query)=>({rows:readRows(query.keys)}),
  getSessionKysely:()=>({selectFrom:()=>({selectAll:()=>({where:(_field,_op,keys)=>({orderBy:()=>({keys})})})})}),
  writeSessionEntry:(_database,key,entry)=>{counters.writes++;db.prepare('UPDATE session_nodes SET entry_json=? WHERE session_key=?').run(JSON.stringify(entry),key);return entry;}
 };
 const program=[snippet('session-accessor.sqlite-entry-store-DTntRuil.mjs','equality-region'),
  snippet('session-accessor.sqlite-entry-store-DTntRuil.mjs','readUnchangedLifecycleTargetSnapshot'),
  captured('function applySessionEntryPatchInDatabase(', '//#endregion\n//#region src/config/sessions/session-accessor.sqlite-history.ts'),
  snippet('openclaw-agent-db-CaQAStOA.mjs','runOpenClawAgentWriteTransaction'),
  captured('async function patchSqliteSessionEntrySnapshot(', 'async function recordInboundSessionMeta('),
  '\n({patchSqliteSessionEntrySnapshot})'].join('\n');
 const native=vm.runInNewContext(program,context);
 return {label:'internal SQLite entry patch',close(){},
  patch:(key,update)=>native.patchSqliteSessionEntrySnapshot({sessionKey:key,resolved:{agentId:'main',env:{}},readSnapshot:()=>snapshot(key),update,options:PROFILE_OPTIONS,operationLabel:'authored-model-profile'})};
}

// 2026.10.9: the public plugin-SDK patchSessionEntry (projection + external commit guard), its core, and the writer
// it selects. mode "worker" = the main-thread production default (useWorker: no shouldCommit/assertCommitAllowed):
// preparation on the main thread, commit by the worker kernel commitSessionEntryPatch in runOpenClawAgentWriteTransaction
// on its own connection. mode "direct" = runOpenClawAgentWriteWithYieldingAdmission when worker execution is unsupported.
function build109(mode,hooks={}){
 const root=path.join(fixtures,'openclaw-2026.10.9-model-flow-sdk');
 const snippets=require(path.join(root,'native-session-cas-snippets.json'));
 assert.equal(snippets.capture.package,'openclaw@2026.10.9');
 const snippet=(module,name)=>{const m=snippets.files.find(x=>x.module===module);assert.ok(m,module);const s=m.snippets.find(x=>x.name===name);assert.ok(s,name);assert.equal(sha(s.source),s.snippet_sha256,module+' '+name);return s.source;};
 const worker=new DatabaseSync(file);
 const mainDatabase={db,path:file,agentId:'main'},workerDatabase={db:worker,path:file,agentId:'main'};
 const parse=r=>JSON.parse(r.entry_json);
 const scanRow=(connection,key)=>{const rows=readRowsOn(connection,[key.trim()]);return rows[0]?{selected:{row:rows[0],entry:parse(rows[0])},lookupKeys:[key.trim()],rows}:undefined;};
 let candidate,native;
 const fakeProcess={env:{}};
 const context={process:fakeProcess,Map,Set,Error,JSON,Promise,Object,Array,Boolean,structuredClone,performance,
  // public layer ports
  loadSessionEntryReadOnly:scope=>{const r=readRowsOn(db,[scope.sessionKey])[0];return r?parse(r):undefined;},
  listSessionEntriesReadOnly:params=>readRowsOn(db).filter(r=>r.session_key.startsWith('agent:'+params.agentId+':')).map(r=>({sessionKey:r.session_key,entry:parse(r)})),
  listSessionEntriesCore:()=>{throw Error('profile reads use readOnly listing');},
  normalizeResolvedMaintenanceConfigInput:x=>x,
  // scope and identity ports
  resolveSqliteScope:scope=>({agentId:scope.agentId,sessionKey:scope.sessionKey,env:scope.env}),assertCanonicalSessionKeyWrite(){},
  resolveSessionStorePathForScope:()=>file,cloneEnvWithPlatformSemantics:env=>({...env}),resolveStateDir:()=>directory,
  toDatabaseOptions:resolved=>({agentId:resolved.agentId,env:resolved.env}),resolveOpenClawAgentSqlitePath:()=>file,
  readDatabasePathIdentitySync:()=>({key:'file:authored-database',birthtime:1}),assertExistingDatabaseIdentity(){},
  isIncognitoOpenClawAgentSqlitePath:()=>false,captureIncognitoSessionBinding:()=>undefined,isMainThread:true,
  supportsOpenClawAgentDatabaseExecution:()=>mode==='worker',assertCapturedSessionEntryReadSource(){},
  // entry rows (authored single-table store; real snapshot/CAS functions above them)
  readSessionEntryRowScan:(database,key)=>scanRow(database.db,key),readExactSessionEntryRow:(database,key)=>scanRow(database.db,key)?.selected,
  executeSqliteQuerySync:(_connection,query)=>({rows:readRowsOn(query.connection,query.keys)}),sqliteStringSet:keys=>keys,
  getSessionKysely:connection=>({selectFrom:()=>({selectAll:()=>({where:(_field,_op,keys)=>({orderBy:()=>({connection,keys})})})})}),
  isDeepStrictEqual:require('node:util').isDeepStrictEqual,assertCanonicalSqliteSessionKeysCurrent(){},
  writeSessionEntry:(database,key,entry)=>{counters.writes++;database.db.prepare('UPDATE session_nodes SET entry_json=? WHERE session_key=?').run(JSON.stringify(entry),key);return entry;},
  mergeSessionEntry:(entry,patch)=>({...entry,...patch}),mergeSessionEntryPreserveActivity:(entry,patch)=>({...entry,...patch}),
  preserveSqliteSameKeySessionRolloverLineage:({next})=>next,reduceSessionEntryPatch:()=>{throw Error('fixed operations are not used by the profile owner');},
  // database owner ports
  getOpenClawAgentDatabaseIfOpen:()=>mainDatabase,openOpenClawAgentDatabase:()=>mainDatabase,openAgentDatabase:()=>workerDatabase,
  withOpenClawAgentDatabaseRuntime:(_options,op)=>op(),runExclusiveSqliteSessionWrite:(_scope,op)=>op(),retainAgentDatabase:()=>()=>{},
  assertAgentDeletionDatabaseCleanupAccess(){},assertAgentCreationClaimAccess(){},assertOpenClawAgentDatabaseIdentity(){},ensureOpenClawAgentDatabasePermissions(){},
  getAgentDeletionDatabaseCleanup:()=>undefined,cache:{incognito:new Set()},withSqlitePostCommitPublications:(_db,op)=>op(),readSqliteBusyTimeout:()=>5000,
  runSqliteImmediateTransactionSync:(connection,op)=>{counters.transactions++;connection.exec('BEGIN IMMEDIATE');try{const result=op();connection.exec('COMMIT');return result;}catch(e){connection.exec('ROLLBACK');throw e;}},
  runSqliteImmediateTransaction:async(connection,prepare,options,admit=write=>write())=>{const operation=await prepare();if(!operation)return;await hooks.beforeCommit?.();counters.directCommits++;return admit(()=>context.runSqliteImmediateTransactionSync(connection,operation,options));},
  prepareSessionIdentityPublication:()=>()=>{},readOpenClawAgentDatabaseIdentity:()=>({identity:'authored-database',birthtime:1}),
  kickSessionEntryMaintenanceAfterWrite(){},kickSessionHistoryDiskBudgetMaintenance(){},resolveSqliteTranscriptArchiveDirectory:()=>directory,
  patchIncognitoSessionEntry:()=>{throw Error('no incognito binding in this fixture');},
  // worker kernel ports (transport only; CAS and write are the kernel's own functions)
  isRecord:v=>v!==null&&typeof v==='object'&&!Array.isArray(v),captureTrajectoryRuntimeRetentionMetadataMutation:()=>undefined,
  readSessionSourceValidation:(_database,sources)=>{assert.deepEqual(sources,[],'no prepared source predicates for the plugin SDK callback');return {conversationMatches:[]};},
  prepareSessionEntryReplacementPublication:identity=>({changedKeys:[...identity.current.keys()]}),
  transferSessionEntryWorkerCandidate:(_database,admit,result)=>{candidate=result;const receipt={kind:'session-entry-patch-committed',transferId:1};admit('commit',receipt);return receipt;},
  // Authored transport of patchSessionEntryInWorker (session-entry-patch-fXJDvWHG.mjs): the worker reads the snapshot on
  // its connection, the main thread prepares, the worker commits; payloads cross by structured clone as postMessage does.
  patchSessionEntryInWorker:async params=>{
   const source=params.preparedSource;
   params.assertCurrent();params.guard?.assertCurrent?.();source?.assertCurrent();
   const prepared=structuredClone(native.readSessionEntryPatchSnapshot(workerDatabase,params.selection));
   const input=await params.prepare(prepared);
   params.assertCurrent();params.guard?.assertCurrent?.();
   if(!input)return {entry:null,wrote:false};
   if(source){input.sources=source.checks.map(check=>check.predicate);source.assertCurrent();}
   await hooks.beforeCommit?.();
   counters.workerCommits++;candidate=undefined;
   native.commitSessionEntryPatch(structuredClone(input),native.createSessionWorkerOperationContext(workerDatabase,{agentId:'main',path:file},{admit(){}},'session-entry-patch'));
   assert.ok(candidate,'worker commit produced its candidate');
   return {entry:candidate.entry,wrote:Boolean(candidate.publication)};
  },
 };
 const S='session-store-runtime-B8fW3ciZ.mjs',E='session-accessor.sqlite-entry-DLa7_9ui.mjs',A='session-source-authority-h1UO3u0I.mjs';
 const program=[
  snippet('session-entry-projection-DwG6-KIA.mjs','projection-region'),
  snippet('main-session-recovery-clear-B0tByn8u.mjs','MAIN_SESSION_RECOVERY_CLEAR_PATCH'),
  snippet('session-store-runtime-internal-CtkzYf1V.mjs','toSessionAccessScope..clearGenerationPrivateFieldsForRotatedSessionPatch'),
  snippet(A,'sessionEntryCommitGuardOptions'),snippet(A,'captureExternalSessionCommitGuard'),snippet(A,'prepareSessionSourceAuthority'),
  snippet('session-mutation-conflict-error-CSUFwifz.mjs','SqliteSessionMutationConflictError'),
  snippet('session-accessor.sqlite-entry-equality-w0pZmXiY.mjs','equality-region'),
  snippet('session-accessor.sqlite-entry-store-CIM2yoGL.mjs','readSessionEntrySelectionSnapshot..readUnchangedLifecycleTargetSnapshot'),
  snippet('session-accessor.sqlite-entry-mutation-CxTIILGh.mjs','patch-guard+mutation-region'),
  snippet('session-entry-patch-operation-C0KSoGVF.mjs','mergeSessionEntryPatch'),
  snippet('openclaw-agent-db-DWI9Bgur.mjs','runOpenClawAgentWriteTransaction'),
  snippet('openclaw-agent-db-transaction-D2d1A44G.mjs','runOpenClawAgentWriteWithYieldingAdmission'),
  snippet('session-entry-patch.worker-D77IuVN7.mjs','createSessionWorkerOperationContext..commitSessionEntryPatch'),
  snippet(E,'captureSessionEntryPatchSource'),snippet(E,'patchSessionEntryCore..patchSessionEntryInScope'),snippet(E,'patchSqliteSessionEntrySnapshot'),
  snippet(S,'preserveGenerationPrivateFields+getSessionEntry'),snippet(S,'listSessionEntries'),snippet(S,'patchSessionEntry'),
  '\n({patchSessionEntry,getSessionEntry,listSessionEntries,readSessionEntryPatchSnapshot,commitSessionEntryPatch,createSessionWorkerOperationContext})'].join('\n');
 native=vm.runInNewContext(program,context);
 return {label:`public patchSessionEntry, ${mode} writer`,native,close(){worker.close();},
  patch:(key,update)=>native.patchSessionEntry({agentId:'main',sessionKey:key,update,...PROFILE_OPTIONS})};
}

// The scenario every version must hold for the profile metadata write (unchanged from the 2026.9.6 test).
async function commonScenario(h,expected){
 const start={...counters};const delta=()=>({writes:counters.writes-start.writes,transactions:counters.transactions-start.transactions});
 const key='agent:main:authored-session',original={sessionId:'authored-generation',lifecycleRevision:3,updatedAt:123,pluginExtensions:{other:{retain:true}}};seed(key,original);
 const saved=await h.patch(key,fresh=>({pluginExtensions:{...fresh.pluginExtensions,profile:{version:1,model:'openai/authored'}}}));
 assert.equal(saved.updatedAt,123);assert.deepEqual(clone(saved.pluginExtensions.other),{retain:true});assert.equal(delta().writes,1);
 const old=clone(row(key)),beforeWrites=delta().writes;
 await assert.rejects(h.patch(key,async fresh=>{
  foreignWrite(key,{...fresh,sessionId:'new-generation',lifecycleRevision:4});
  return {pluginExtensions:{...fresh.pluginExtensions,stale:{mustNotPersist:true}}};
 }),/SQLite session state changed/);
 assert.equal(delta().writes,beforeWrites);assert.equal(row(key).sessionId,'new-generation');assert.equal(row(key).pluginExtensions.stale,undefined);
 seed(key,old);
 await assert.rejects(h.patch(key,async fresh=>{
  foreignWrite(key,{...fresh,pluginExtensions:{...fresh.pluginExtensions,concurrent:{retain:true}}});
  return {pluginExtensions:{...fresh.pluginExtensions,stale:{mustNotPersist:true}}};
 }),/SQLite session state changed/);
 assert.equal(row(key).pluginExtensions.concurrent.retain,true);assert.equal(row(key).pluginExtensions.stale,undefined);
 assert.equal(delta().writes,beforeWrites,'SDK rechecks the complete prepared entry, including same-generation concurrent metadata');
 const unchanged=row(key);await h.patch(key,()=>null);assert.deepEqual(row(key),unchanged);assert.equal(delta().writes,beforeWrites);
 const started=Date.now();
 for(let i=0;i<451;i++){
  const k='agent:main:authored-volume-'+i;seed(k,{...original,sessionId:'authored-volume-'+i});
  await h.patch(k,fresh=>({pluginExtensions:{...fresh.pluginExtensions,profile:{version:1,model:'openai/authored'}}}));
 }
 assert.ok(Date.now()-started<25000,'451 real SQLite metadata writes exceed the existing preparation budget');
 assert.equal(db.prepare('SELECT count(*) AS n FROM session_nodes').get().n,452);
 assert.deepEqual(delta(),expected);
 db.exec('DELETE FROM session_nodes');
}

// conversationModelProfile.ts persistence (readProfile + pin with its sessionId/lifecycleRevision check and canonical
// re-read), sliced from the plugin source and type-stripped by Node, run against the 2026.10.9 public SDK functions.
function pluginPin(){
 const source=fs.readFileSync(path.resolve(__dirname,'../../openclaw-plugin-mobile-ui/src/companion/conversationModelProfile.ts'),'utf8');
 const cut=(begin,end)=>{const a=source.indexOf(begin),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,begin);return source.slice(a,b);};
 const ts=cut('export const MODEL_PROFILE_NAMESPACE=','export type ModelFlow=').replace(/^export /,'')+cut('function readProfile(','/** Called from R6 only');
 const js=require('node:module').stripTypeScriptTypes(ts);
 return vm.runInNewContext(js+'\n({pin,readProfile,MODEL_PROFILE_NAMESPACE,PLUGIN})',{createHash:crypto.createHash,Buffer,Object,JSON,Error,Promise,setTimeout,clearTimeout,Math});
}
async function pluginScenario(mode){
 const hooks={};const h=build109(mode,hooks);const plugin=pluginPin(),NS=plugin.MODEL_PROFILE_NAMESPACE,PLUGIN=plugin.PLUGIN;
 try{
  const owner={getSessionEntry:p=>h.native.getSessionEntry(p),patchSessionEntry:p=>h.native.patchSessionEntry(p)};
  const listed=key=>h.native.listSessionEntries({agentId:'main',readOnly:true}).find(r=>r.sessionKey===key).entry;
  const key='agent:main:authored-profile';
  const privateFields={activeWriterRunId:'authored-writer-run',lifecycleRunId:'authored-lifecycle-run'};
  seed(key,{sessionId:'authored-generation',lifecycleRevision:7,updatedAt:456,pluginExtensions:{other:{retain:true}},...privateFields});
  const profile=gen=>({version:1,sessionId:gen,flow:'brain',selection:{model:{primary:'openai/authored-primary',fallbacks:['openai/authored-fallback']},thinkingDefault:'high',fastModeDefault:null},summaryModel:null});
  // Projection: the plugin sees no private keys, and its update leaves them in the native row.
  const entry=listed(key);assert.equal(entry.activeWriterRunId,undefined);assert.equal(entry.lifecycleRevision,7);
  const writes0=counters.writes;
  const chosen=await plugin.pin(owner,'main',key,entry,profile('authored-generation'));
  assert.deepEqual(clone(chosen),profile('authored-generation'));assert.equal(counters.writes-writes0,1);
  const stored=row(key);assert.deepEqual(stored.pluginExtensions[PLUGIN][NS],profile('authored-generation'),'pluginExtensions survive projectPublicSessionEntryPatch');
  assert.deepEqual(stored.pluginExtensions.other,{retain:true});assert.equal(stored.updatedAt,456,'preserved activity');
  assert.equal(stored.activeWriterRunId,privateFields.activeWriterRunId);assert.equal(stored.lifecycleRunId,privateFields.lifecycleRunId);assert.equal(stored.lifecycleRevision,7);
  assert.equal(owner.getSessionEntry({agentId:'main',sessionKey:key}).activeWriterRunId,undefined,'public read stays projected');
  // First pin wins: a different later value returns the stored profile without a write.
  const again=await plugin.pin(owner,'main',key,listed(key),{...profile('authored-generation'),summaryModel:'openai/authored-other'});
  assert.deepEqual(clone(again),profile('authored-generation'));assert.equal(counters.writes-writes0,1);
  // Reset between listing and pin: the plugin's own generation check refuses (409), nothing written.
  const k2='agent:main:authored-reset';seed(k2,{sessionId:'g1',lifecycleRevision:1,updatedAt:1,pluginExtensions:{}});
  const before=listed(k2);foreignWrite(k2,{sessionId:'g2',lifecycleRevision:2,updatedAt:2,pluginExtensions:{}});
  await assert.rejects(plugin.pin(owner,'main',k2,before,profile('g1')),e=>e.statusCode===409&&e.message==='model_flow_profile_unavailable');
  assert.equal(row(k2).sessionId,'g2');assert.equal(row(k2).pluginExtensions[PLUGIN],undefined);assert.equal(counters.writes-writes0,1);
  // Same-generation metadata written by another process after preparation, before commit: the writer's CAS refuses.
  const k3='agent:main:authored-concurrent';seed(k3,{sessionId:'g1',lifecycleRevision:1,updatedAt:1,pluginExtensions:{other:{retain:true}}});
  hooks.beforeCommit=()=>{hooks.beforeCommit=undefined;foreignWrite(k3,{...row(k3),pluginExtensions:{other:{retain:true},concurrent:{retain:true}}});};
  await assert.rejects(plugin.pin(owner,'main',k3,listed(k3),profile('g1')),/SQLite session state changed/);
  assert.equal(row(k3).pluginExtensions.concurrent.retain,true);assert.equal(row(k3).pluginExtensions[PLUGIN],undefined,'no stale profile write');assert.equal(counters.writes-writes0,1);
  // A retry starts from the fresh row and keeps both.
  await plugin.pin(owner,'main',k3,listed(k3),profile('g1'));
  assert.equal(row(k3).pluginExtensions.concurrent.retain,true);assert.deepEqual(row(k3).pluginExtensions[PLUGIN][NS],profile('g1'));assert.equal(counters.writes-writes0,2);
  db.exec('DELETE FROM session_nodes');
 }finally{h.close();}
}

(async()=>{
 try{
  if(version==='2026.9.6'){
   await commonScenario(build96(),{writes:452,transactions:455});
   console.log('Native SDK functions + authored SQLite I/O PASS (OpenClaw 2026.9.6): async preparation, separate-process reset and metadata conflict, exact rollback/no stale write, preserved activity,451 rows; no S24 database or model call.');
  }else{
   for(const mode of ['worker','direct']){
    const h=build109(mode);
    // Both writers: every prepared patch, the null patch included, reaches one transaction that rechecks the rows.
    const before={worker:counters.workerCommits,direct:counters.directCommits};
    try{await commonScenario(h,{writes:452,transactions:455});}finally{h.close();}
    await pluginScenario(mode);
    const used={worker:counters.workerCommits-before.worker,direct:counters.directCommits-before.direct};
    assert.ok(mode==='worker'?used.worker>450&&used.direct===0:used.direct>450&&used.worker===0,'writer selected by captureSessionEntryPatchSource: '+JSON.stringify(used));
   }
   console.log('Native SDK functions + authored SQLite I/O PASS (OpenClaw 2026.10.9): public patchSessionEntry projection and external commit guard, worker-kernel and direct writers; async preparation, separate-process reset and metadata conflict, exact rollback/no stale write, preserved activity,451 rows; conversationModelProfile pin: projected entry, pluginExtensions and private keys kept, first pin wins, reset refused 409, CAS refusal then clean retry. No S24 database or model call.');
  }
 }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
