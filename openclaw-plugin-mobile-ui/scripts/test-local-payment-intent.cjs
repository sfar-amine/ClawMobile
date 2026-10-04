const test=require('node:test');
const assert=require('node:assert/strict');
const {buildLocalPaymentIntent,localPaymentPayloadHash,parseLocalPaymentReference}=require('../dist/companion/localPaymentIntent.js');
const quote={payee:'TOPNET',reference:'INV-1',amountMinor:60900,currency:'TND',decimals:3};
const origin={channel:'chatgpt',id:'turn-1'};

test('local payment intent is deterministic and preserves requester origin',()=>{
 const intent=buildLocalPaymentIntent({adapterId:'topnet',quote,origin});
 assert.equal(intent.action.type,'payment.local_start');
 assert.equal(intent.action.reference,'topnet:INV-1');
 assert.equal(intent.action.payloadHash,localPaymentPayloadHash('topnet',quote));
 assert.deepEqual(intent.origin,origin);
 assert.equal(intent.presentation.title,'Autoriser le paiement');
 assert.equal(intent.presentation.subtitle,'60,900 TND à TOPNET');
 assert.match(intent.presentation.description,/INV-1/);
});

test('fresh quote changes both signed payload and presentation',()=>{
 const before=buildLocalPaymentIntent({adapterId:'topnet',quote,origin});
 const after=buildLocalPaymentIntent({adapterId:'topnet',quote:{...quote,amountMinor:62000},origin});
 assert.notEqual(after.action.payloadHash,before.action.payloadHash);
 assert.notEqual(after.presentation.subtitle,before.presentation.subtitle);
 assert.deepEqual(after.origin,before.origin);
});

test('local payment reference parser is strict',()=>{
 assert.deepEqual(parseLocalPaymentReference('topnet:INV-1'),{adapterId:'topnet',providerReference:'INV-1'});
 for(const value of ['https://topnet.tn/x','topnet:INV/1',':INV-1','topnet:'])
  assert.throws(()=>parseLocalPaymentReference(value));
});
