import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackJournal } from './claw-slack-journal.mjs';
const base = process.env.CLAW_TEST_TMPDIR || process.env.TMPDIR || path.join(os.homedir(), '.cache', 'tmp');
fs.mkdirSync(base,{recursive:true});
function fixture(fn) { const root=fs.mkdtempSync(path.join(base,'journal-test-'));try{fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});} }
const event = ts => ({channel:'C',ts,user:'OWNER'});
test('queue limit rejects before accepting additional work; duplicate event consumes no slot',()=>fixture(root=>{
 const j=new SlackJournal(root,{limit:1});const a=j.add(event('1'),{requestId:'a'});
 assert.equal(j.add(event('1'),{}).key,a.key);
 assert.throws(()=>j.add(event('2'),{}),/queue_full/);
 j.delivered(a,'done');assert.equal(new SlackJournal(root).get('C','1').state,'delivered');
 j.add(event('2'),{});assert.equal(j.stats().pending,1);
}));
test('private payload is erased on delivery and metadata retention is bounded',()=>fixture(root=>{
 let now=1;const j=new SlackJournal(root,{retentionMs:5,now:()=>now});
 const a=j.add(event('1'),{requestId:'a',params:{private:'sample'}},'private output');j.delivered(a,'1');
 const raw=fs.readFileSync(path.join(root,a.key+'.json'),'utf8');assert.ok(!raw.includes('private'));
 assert.equal(fs.statSync(path.join(root,a.key+'.json')).mode&0o777,0o600);
 now=10;j.prune();assert.equal(j.rows.size,0);
}));
test('corrupt existing journal fails closed',()=>fixture(root=>{
 fs.writeFileSync(path.join(root,'a'.repeat(64)+'.json'),'{bad');
 assert.throws(()=>new SlackJournal(root));
}));
