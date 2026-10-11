const assert=require('node:assert/strict');
const api=require('../dist/companion/fileReadBoundary');
for(const name of ['../notes','notes/../other','/etc/passwd','a\\b','a%2fb','a%252fb','a\0b','a//b','.env','credentials.json','mycredentialfile.txt','accessToken.txt','other-secret-value','auth-profile.json','notes/private.key','context/file','context-backup/file','otp.txt','user@example.test.md','ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef.txt','github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi.md','backups/AGENTS.md.bak','SOUL.md.backup','AKIAABCDEFGHIJKLMNOP.md','eyJabc.payload.signature.md'])assert.throws(()=>api.safeFileName(name),e=>e.statusCode===404);
assert.equal(api.safeFileName('notes/été.txt'),'notes/été.txt');
for(const word of ['pays','paysage','paiement','recharge','bank','invoice','purchase','payload']){const name='notes/'+word+'.txt';assert.equal(api.safeFileName(name),name);assert.equal(api.boundedFileContent(name,Buffer.from('Policy mentions '+word)).bytes.toString(),'Policy mentions '+word);}
for(const name of ['screenshots/probe.png','ui-dumps/probe.xml']){assert.equal(api.safeFileName(name),name);assert.throws(()=>api.boundedFileContent(name,Buffer.from('hello')),e=>e.statusCode===404);}
for(const text of ['sk-proj-ABCDEFGHIJKLMNabcdefghijk','github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi','ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef','Code 123456','AKIAABCDEFGHIJKLMNOP','eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature','private@example.test','token=private-fixture'])assert.equal(api.boundedFileContent('notes/read.txt',Buffer.from(text)).bytes.toString(),'[masqué]');
const pem=api.boundedFileContent('notes/read.md',Buffer.from('Notes\n-----BEGIN PRIVATE KEY-----\nQUJDREVG\n-----END PRIVATE KEY-----'));assert.equal(pem.bytes.toString(),'[masqué]');assert.equal(pem.redacted,true);
const text=api.boundedFileContent('notes/read.txt',Buffer.from('Lecture locale\nBonjour'));assert.equal(text.bytes.toString(),'Lecture locale\nBonjour');assert.equal(text.redacted,false);
const long=api.boundedFileContent('notes/large.txt',Buffer.from('é'.repeat(200000)));assert.equal(long.bytes.length,api.FILE_TEXT_BYTES);assert.equal(long.truncated,true);
const split=api.boundedFileContent('notes/large.txt',Buffer.from('a'.repeat(api.FILE_TEXT_BYTES-1)+'é'));assert.equal(split.bytes.length,api.FILE_TEXT_BYTES-1);assert.equal(split.truncated,true);
for(const bytes of [Buffer.from([0,1,2]),Buffer.from([255,0]),Buffer.from([255]),Buffer.from('GIF8bad\0')])assert.throws(()=>api.boundedFileContent('notes/read.txt',bytes),e=>e.statusCode===404);
assert.throws(()=>api.boundedFileContent('notes/invalid.txt',Buffer.concat([Buffer.alloc(api.FILE_TEXT_BYTES-1,97),Buffer.from([255,97])])),e=>e.statusCode===404);
const png=Buffer.from([137,80,78,71,13,10,26,10]);assert.equal(api.boundedFileContent('images/probe.png',png).contentType,'image/png');
assert.equal(api.boundedFileContent('images/probe.jpeg',Buffer.from([255,216,255,224])).contentType,'image/jpeg');
assert.throws(()=>api.boundedFileContent('images/probe.png',Buffer.concat([png,Buffer.alloc(api.FILE_IMAGE_BYTES)])),e=>e.statusCode===404);
const expanded=api.boundedFileContent('notes/redactions.txt',Buffer.from('@\n'.repeat(200000)));assert.ok(expanded.bytes.length<=api.FILE_TEXT_BYTES);assert.equal(expanded.truncated,true);
assert.equal(api.FILE_LIST_LIMIT,250);
assert.equal(api.safeFileName("memory/2026-10-10.md"),"memory/2026-10-10.md");
assert.equal(api.safeFileName("notes/code123456.txt"),"notes/code123456.txt");
const dated=api.boundedFileContent('memory/2026-10-10.md',Buffer.from('Journal du 2026-10-10\nPoint 10/10/2026 à 22:00'));assert.equal(dated.bytes.toString(),'Journal du 2026-10-10\nPoint 10/10/2026 à 22:00');assert.equal(dated.redacted,false);
assert.equal(api.boundedFileContent('notes/numbers.txt',Buffer.from('n 4111 1111 1111 1111')).bytes.toString(),'[masqué]');
console.log('R20 local boundary fixtures passed: paths, secret redaction, ordinary financial text preservation, list-only sensitive media, UTF-8 cap and PNG/JPEG magic; no Gateway or S24 qualification');
