// F2 (doc 62): a failed Gemini Live token helper keeps its cause, bounded and without credential or command line.
const assert=require('node:assert/strict');
const {tokenHelperFailure}=require('../dist/companion/clawLive');
const timeout=tokenHelperFailure({code:null,signal:'SIGTERM',killed:true,stderr:''},15003);
assert.equal(timeout,'gemini_live_token_helper_failed exit=none signal=SIGTERM killed=true ms=15003 stderr=empty');
const quota=tokenHelperFailure({code:1,signal:null,killed:false,stderr:'\nError: 429 RESOURCE_EXHAUSTED key=AIzaSyA1234567890abcdefghijklmnop\nstack'},812);
assert.match(quota,/^gemini_live_token_helper_failed exit=1 signal=none killed=false ms=812 stderr=Error: 429 RESOURCE_EXHAUSTED key=<redacted>$/);
assert(!quota.includes('AIza'));assert(!quota.includes('/data/data'));
assert(tokenHelperFailure({code:1,stderr:'x'.repeat(5000)},1).length<220);
// S24 18/10 14:03: exit 75, empty stderr; the helper's cause is its stdout JSON line.
const upstream=tokenHelperFailure({code:75,signal:null,killed:false,stderr:'',stdout:'{"status":"error","reason":"gemini_live_token_failed:503"}\n'},775);
assert.equal(upstream,'gemini_live_token_helper_failed exit=75 signal=none killed=false ms=775 reason=gemini_live_token_failed:503 stderr=empty');
const secret=tokenHelperFailure({code:75,stdout:'{"status":"error","reason":"fetch failed key=AIzaSyA1234567890abcdefghijklmnop'+'y'.repeat(400)+'"}'},1);
assert(!secret.includes('AIza'));assert(secret.length<360);
assert.equal(tokenHelperFailure({code:75,stdout:'not json'},1),'gemini_live_token_helper_failed exit=75 signal=none killed=false ms=1 stderr=empty');
console.log(JSON.stringify({suite:'claw-live-token-failure',passed:7}));
