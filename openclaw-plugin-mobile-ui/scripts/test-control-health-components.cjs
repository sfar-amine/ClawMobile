const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {projectHealthComponents, completeHealthSection} = require('../dist/companion/control-health');
const {handleControl} = require('../dist/companion/control');
const now = 1800000000000;
const verdict = (changes = {}) => ({generated_at: now / 1000, overall: 'degraded', capabilities: {
  'control_plane.maintenance': {state: 'degraded', checked_at: now / 1000, reason: 'daily_log_audit', secret: 'never-copy'},
  'device.adb': {state: 'ready'}, 'custom.monitor': {state: 'down', reason: 'probe failed'},
}, ...changes});
const data = () => ({status: 'degraded', fresh: true, components: [{id: 'immune.health_manager', name: 'Health Manager', status: 'healthy'}]});
const envelope = () => ({schemaVersion: 2, sections: {health: {schemaVersion: 2, resourceKey: 'control/v2/health', dataRevision: 'a'.repeat(64), availability: 'ready', freshness: 'fresh', remainingFreshMs: 15000, data: data()}}});
const request = (port, url) => new Promise((resolve, reject) => {
  http.get({host:'127.0.0.1', port, path:url}, response => {
    let body=''; response.on('data', part => body += part); response.on('end', () => resolve({status:response.statusCode, body:JSON.parse(body)}));
  }).on('error', reject);
});
(async () => {
  const original = data(); const projected = projectHealthComponents(original, verdict(), now);
  assert.equal(original.components.length, 1);
  const maintenance = projected.components.find(row => row.id === 'control_plane.maintenance');
  assert.equal(maintenance.status, 'degraded'); assert.equal(maintenance.description, 'Audit du journal quotidien incomplet.');
  assert.deepEqual(maintenance.label, {fr:'Maintenance du système', en:'System maintenance'});
  assert.equal(maintenance.checkedAt, new Date(now).toISOString());
  assert.ok(!JSON.stringify(projected).includes('never-copy'));
  assert.equal(projected.components.find(row => row.id === 'custom.monitor').status, 'failed');
  assert.ok(!projected.components.some(row => row.id === 'device.adb'));
  assert.equal(projectHealthComponents(original, verdict({generated_at:now/1000-301}), now).canonicalVerdict.status, 'unknown');
  assert.equal(projectHealthComponents(original, verdict({generated_at:now/1000+1}), now).canonicalVerdict.fresh, false);
  for (const state of ['stale','unverified','blocked','human_required','new_state']) {
    assert.ok(projectHealthComponents({components:[]}, verdict({capabilities:{'test.component':{state}}}), now).components.length === 1);
  }
  const sensitive = projectHealthComponents(original, verdict({capabilities:{'test.component':{state:'down', reason:'token=secret-value', evidence:'do-not-expose'}}}), now);
  assert.equal(sensitive.components.find(row => row.id === 'test.component').description, 'Diagnostic du composant indisponible.');
  assert.ok(!JSON.stringify(sensitive).includes('do-not-expose'));
  assert.equal(projectHealthComponents({components:[]}, verdict({capabilities:{'bad id':{state:'down'}, 'valid':null}}), now).components.length, 0);
  const existing = projectHealthComponents({components:[{id:'control_plane.maintenance', status:'healthy'}]}, verdict(), now);
  assert.equal(existing.components.filter(row => row.id === 'control_plane.maintenance').length, 1);
  for (const missing of [null, {}, {generated_at: now/1000-301}]) {
    const input={status:'healthy',fresh:true,checkedAt:'legacy-check',components:[{id:'immune.health_manager',name:'Historical name',status:'healthy'}]};
    const output=projectHealthComponents(input,missing,now);
    assert.equal(output.status,input.status);assert.equal(output.fresh,input.fresh);assert.equal(output.checkedAt,input.checkedAt);
    assert.equal(output.components[0].name,'Historical name');
  }
  const named=projectHealthComponents({components:[{id:'control_plane.maintenance',name:'Original maintenance'}]},verdict(),now);
  assert.equal(named.components[0].name,'Original maintenance');
  for(const reason of ['probe failed','private note','token=secret-value','__proto__',null]) {
    const output=projectHealthComponents({},verdict({capabilities:{'custom.monitor':{state:'down',reason}}}),now);
    assert.equal(output.components[0].description,'Diagnostic du composant indisponible.');
    if(reason)assert.ok(!JSON.stringify(output).includes(reason));
  }
  const healthyInput={components:[{id:'immune.health_manager',name:'Original',description:'Healthy historical description',checkedAt:'2026-10-10T00:00:00Z',status:'healthy'}]};
  const healthy=projectHealthComponents(healthyInput,verdict({capabilities:{'immune.health_manager':{state:'ready'}}}),now).components[0];
  assert.equal(healthy.description,'Healthy historical description');assert.equal(healthy.checkedAt,'2026-10-10T00:00:00Z');
  const failed=projectHealthComponents(healthyInput,verdict({capabilities:{'immune.health_manager':{state:'down',reason:'daily_log_audit',checked_at:now/1000}}}),now).components[0];
  assert.equal(failed.description,'Audit du journal quotidien incomplet.');assert.equal(failed.checkedAt,new Date(now).toISOString());
  const composite=projectHealthComponents({components:[]},verdict({capabilities:{'control_plane.maintenance':{state:'degraded',reason:'scheduler_health,daily_log_audit'}}}),now).components[0];
  assert.equal(composite.description,'Planificateur à surveiller. Audit du journal quotidien incomplet.');
  const partlyKnown=projectHealthComponents({components:[]},verdict({capabilities:{'control_plane.maintenance':{state:'degraded',reason:'daily_log_audit,private note'}}}),now).components[0];
  assert.equal(partlyKnown.description,'Audit du journal quotidien incomplet.');assert.ok(!JSON.stringify(partlyKnown).includes('private note'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'control-health-contract-'));
  const saved={home:process.env.HOME, playbooks:process.env.SAMANTHA_CONTROL_PLAYBOOKS, cache:process.env.SAMANTHA_CONTROL_CACHE};
  let server;
  try {
    const source=path.join(root,'current.json'); await fs.writeFile(source,JSON.stringify(verdict()));
    const first=await completeHealthSection(envelope(),source,now);
    const repeat=await completeHealthSection(envelope(),source,now);
    assert.equal(first.sections.health.dataRevision,repeat.sections.health.dataRevision);
    assert.notEqual(first.sections.health.dataRevision,'a'.repeat(64));
    await fs.writeFile(source,JSON.stringify(verdict({capabilities:{'control_plane.maintenance':{state:'down',reason:'daily_log_audit'}}})));
    assert.notEqual((await completeHealthSection(envelope(),source,now)).sections.health.dataRevision,first.sections.health.dataRevision);
    const stale=await completeHealthSection(envelope(),source,now+301000);
    assert.equal(stale.sections.health.freshness,'fresh'); assert.equal(stale.sections.health.remainingFreshMs,15000);
    await fs.writeFile(source,'invalid json'); assert.equal((await completeHealthSection(envelope(),source,now)).sections.health.data.canonicalVerdict.status,'unknown');
    const linked=path.join(root,'linked.json'); await fs.symlink(source,linked);
    assert.equal((await completeHealthSection(envelope(),linked,now)).sections.health.remainingFreshMs,15000);
    await fs.mkdir(path.join(root,'.openclaw/health'),{recursive:true});
    await fs.mkdir(path.join(root,'reporting'));
    await fs.writeFile(path.join(root,'reporting/__init__.py'),'');
    await fs.writeFile(path.join(root,'reporting/control_snapshot.py'),'import json\nprint('+JSON.stringify(JSON.stringify(envelope()))+')\n');
    const liveVerdict=verdict({generated_at:Date.now()/1000}); liveVerdict.capabilities['control_plane.maintenance'].reason='unknown_reason';
    await fs.writeFile(path.join(root,'.openclaw/health/current.json'),JSON.stringify(liveVerdict));
    // Hermetic: the S24 runs with SAMANTHA_CONTROL_CACHE=1 (companion-server.sh); this contract checks uncached reads.
    process.env.HOME=root; process.env.SAMANTHA_CONTROL_PLAYBOOKS=root; delete process.env.SAMANTHA_CONTROL_CACHE;
    server=http.createServer(async(req,res)=>{if(!await handleControl(req,res,req.url)){res.writeHead(404);res.end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
    const response=await request(port,'/control/health?contract=2');assert.equal(response.status,200);
    assert.equal(response.body.sections.health.data.components.find(row=>row.id==='control_plane.maintenance').description,'Diagnostic du composant indisponible.');
    const rev=response.body.sections.health.dataRevision;
    assert.equal((await request(port,'/control/health?contract=2&knownRevision='+rev)).body.sections.health.notModified,true);
    liveVerdict.capabilities['control_plane.maintenance'].reason='daily_log_audit';
    await fs.writeFile(path.join(root,'.openclaw/health/current.json'),JSON.stringify(liveVerdict));
    assert.ok((await request(port,'/control/snapshot?contract=2&sections=health&knownRevision='+rev)).body.sections.health.data);
    console.log('control-health-components: projection, privacy, freshness, revision and HTTP contract passed');
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    for(const [name,value] of [['HOME',saved.home],['SAMANTHA_CONTROL_PLAYBOOKS',saved.playbooks],['SAMANTHA_CONTROL_CACHE',saved.cache]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
