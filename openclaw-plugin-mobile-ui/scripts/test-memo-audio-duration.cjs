const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MAX_MEMO_AUDIO_DURATION_SECONDS,isM4aContainer,memoAudioDurationWithinLimit}=require('../dist/companion/attachmentStorage');

const box=(kind,data=Buffer.alloc(0))=>{const value=Buffer.alloc(8+data.length);value.writeUInt32BE(value.length);value.write(kind,4);data.copy(value,8);return value;};
const mvhd=(timescale,duration,version=0)=>{
 const value=Buffer.alloc(version===0?20:32);value[0]=version;
 if(version===0){value.writeUInt32BE(timescale,12);value.writeUInt32BE(duration,16);}
 else{value.writeUInt32BE(timescale,20);value.writeBigUInt64BE(BigInt(duration),24);}
 return box('mvhd',value);
};
const memo=(brand,timescale,duration,version=0)=>{
 const ftyp=Buffer.alloc(16);ftyp.write(brand);ftyp.write('isom',8);ftyp.write('mp42',12);
 const handler=Buffer.alloc(24);handler.write('soun',8);
 return Buffer.concat([box('ftyp',ftyp),box('moov',Buffer.concat([mvhd(timescale,duration,version),box('trak',box('mdia',box('hdlr',handler)))]))]);
};

assert.equal(MAX_MEMO_AUDIO_DURATION_SECONDS,120);
for(const brand of ['M4A ','mp42','isom']){
 const exact=memo(brand,1000,120000);assert.equal(isM4aContainer(exact),true);assert.equal(memoAudioDurationWithinLimit(exact),true);
 assert.equal(memoAudioDurationWithinLimit(memo(brand,1000,120001)),false);
}
assert.equal(memoAudioDurationWithinLimit(memo('mp42',48000,1,1)),true);
assert.equal(memoAudioDurationWithinLimit(memo('mp42',1,0xfffffffffffffffen,1)),false,'uint64 comparison must not overflow');
assert.equal(memoAudioDurationWithinLimit(memo('mp42',1,0xffffffffffffffffn,1)),false,'unknown uint64 duration must fail closed');
assert.equal(memoAudioDurationWithinLimit(memo('mp42',0,1)),false);
const withoutDuration=memo('mp42',1000,1);const marker=withoutDuration.indexOf(Buffer.from('mvhd'))-4;
const stripped=Buffer.concat([withoutDuration.subarray(0,marker),withoutDuration.subarray(marker+28)]);stripped.writeUInt32BE(stripped.length-24,24);
assert.equal(isM4aContainer(stripped),true);assert.equal(memoAudioDurationWithinLimit(stripped),false,'absent mvhd must fail closed');
for(const malformed of [memo('mp42',1000,1).subarray(0,-1),Buffer.alloc(24),memo('mp42',1000,1,1).subarray(0,-8)])assert.equal(memoAudioDurationWithinLimit(malformed),false);

const captured=fs.readFileSync(path.resolve(__dirname,'../fixtures/s24-2026-10-11/hs8-captures/bonjour-samantha.m4a'));
assert.equal(isM4aContainer(captured),true);assert.equal(memoAudioDurationWithinLimit(captured),true,'captured M4A remains accepted');
assert.ok(fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/ci.yml'),'utf8').includes('test-memo-audio-duration.cjs'));
console.log('HS8 memo duration: M4A/mp42/isom accepted through 120 s; over-limit, absent, malformed and uint64 overflow metadata fail closed');
