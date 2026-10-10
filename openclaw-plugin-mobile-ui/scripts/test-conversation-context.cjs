const assert=require('node:assert/strict');
const {conversationContext}=require('../dist/companion/conversationContext');
const row={totalTokens:4000,totalTokensFresh:true,contextTokens:16000,snapshotAt:1800000000000};
assert.deepEqual(conversationContext(row),{usedTokens:4000,windowTokens:16000,percent:25,source:'gateway',measuredAt:row.snapshotAt});
assert.equal(conversationContext({...row,totalTokens:1,contextTokens:3}).percent,33);
assert.equal(conversationContext({...row,totalTokens:0}).percent,0);assert.equal(conversationContext({...row,totalTokens:20000}).percent,100);
for(const bad of [null,{}, {...row,totalTokensFresh:false},{...row,totalTokensFresh:undefined},{...row,totalTokens:null},{...row,totalTokens:-1},{...row,totalTokens:Infinity},{...row,totalTokens:NaN},{...row,contextTokens:0},{...row,contextTokens:null},{...row,snapshotAt:undefined}])assert.equal(conversationContext(bad),null);
console.log('R18 context preparation: nullable direct fields/freshness, zero token sample and bounded percent; synthetic public-schema fixtures, not installed S24 qualification');
