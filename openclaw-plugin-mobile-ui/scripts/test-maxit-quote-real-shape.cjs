// Devis Maxit de forme réelle (capture S24 11/10 : 5 TND, frais 0,700, total 5,700, « Frais Maxit ») à travers la
// validation réelle du Companion : POST /local-handoffs (validateLocalHandoffInput) et la revalidation de l'adaptateur
// (quote). Aucune fonction de validation n'est simulée ; seule la frontière de processus du runner l'est (liveRun).
// Régression 11/10 : chaque côté testait une forme inventée et la chaîne réelle refusait le devis avec frais.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");

const captured=JSON.parse(fs.readFileSync(path.join(__dirname,"..","fixtures","s24-2026-10-11-rehearsal","maxit-topup-quote.json"),"utf8"));
const quote=captured.quote;
const tmp=path.join(os.homedir(),".cache","claw-tests");fs.mkdirSync(tmp,{recursive:true});
const state=fs.mkdtempSync(path.join(tmp,"maxit-real-shape-"));
fs.mkdirSync(path.join(state,"clawmobile-companion"),{recursive:true});
fs.writeFileSync(path.join(state,"clawmobile-companion","maxit-topup-live-acceptance.enabled"),"maxit-topup-v1-live-acceptance\n");
process.env.OPENCLAW_STATE_DIR=state; // the adapter registry reads its gate at module load, as on the S24
const {validateLocalHandoffInput,localHandoffNotificationArgs}=require("../dist/companion/payments.js");
const {validateQuote,quoteDigest}=require("../dist/companion/paymentCore.js");
const {createMaxitTopupLivePaymentAdapter}=require("../dist/companion/maxitTopupLivePaymentAdapter.js");
const requestKey="11111111-1111-4111-8111-111111111111";

test("captured S24 quote passes the local-handoff validation unchanged",()=>{
  const v=validateLocalHandoffInput({requestKey,adapterId:"maxit.topup",quote,origin:{channel:"claw",id:"real-shape"},notify:true});
  assert.deepEqual(v.quote,quote);
  assert.deepEqual([v.quote.amountMinor,v.quote.feeMinor,v.quote.totalMinor,v.quote.feeLabel],[5000,700,5700,"Frais Maxit"]);
  assert.match(quoteDigest("maxit.topup","live",validateQuote(quote)),/^[a-f0-9]{64}$/);
  assert.match(localHandoffNotificationArgs(requestKey,v.quote).join(" "),/5,700 TND/);
});

test("captured quote, as the runner CLI emits it, passes the adapter revalidation",async()=>{
  const adapter=createMaxitTopupLivePaymentAdapter({stateDir:state,
    liveRun:async(_script,payload)=>{assert.deepEqual(payload,{operation:"quote",reference:quote.reference});
      return {schema_version:1,state:"quote_ready",quote};}});
  const fresh=validateQuote(await adapter.quote(quote.reference));
  assert.equal(quoteDigest("maxit.topup","live",fresh),quoteDigest("maxit.topup","live",validateQuote(quote)));
});

test("drift from the captured shape is still refused (fail closed)",()=>{
  for(const change of [{totalMinor:5000},{feeMinor:-1},{note:"x"}])
    assert.throws(()=>validateLocalHandoffInput({requestKey,adapterId:"maxit.topup",quote:{...quote,...change},origin:{channel:"claw",id:"x"},notify:true}));
  const {feeMinor,...partial}=quote;
  assert.throws(()=>validateQuote(partial));
});
