// « Ou dis simplement » : GET /v1/catalog recopie themes[].exampleFr de HS1 (phrase française à dire, même valeur
// en FR et en EN). Entrées : sources S24 réelles (fixtures/s24-2026-10-11d/hs2-catalog-sources.json) et la projection
// HS1 calculée dessus par samantha-ui-playbooks feat/catalog-example-fr-20261011 (hs1-catalog-example-fr-from-s24-sources.*).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fixtures=path.join(__dirname,'../fixtures/s24-2026-10-11d');
const read=name=>JSON.parse(fs.readFileSync(path.join(fixtures,name),'utf8'));
const {catalogProjection,parseSurfaceView}=require('../dist/companion/catalog');
const view=parseSurfaceView(read('hs2-catalog-sources.json').view);assert.ok(view);
const expected={bills:'État de mes factures',lines:'Mon solde Orange',pulse:'Liste des offres Pulse',wallets:null,
  device:'Quel est mon niveau de batterie ?',agenda:"Qu'est-ce que j'ai aujourd'hui dans mon agenda ?",
  qa:'Donne le rapport des tests automatiques',music:'Mets de la musique sur Spotify',laptop:"État de l'accès PC",search:null};
const byTheme=v=>Object.fromEntries(v.themes.map(t=>[t.id,t]));
let checks=0;
for(const locale of ['fr','en']){
  const hs1=read(`hs1-catalog-example-fr-from-s24-sources.${locale}.json`);
  const v=catalogProjection(hs1,view);const themes=byTheme(v);
  // Recopie exacte, y compris null ; la langue de l'appareil ne change pas la phrase à dire.
  assert.deepEqual(Object.fromEntries(v.themes.map(t=>[t.id,t.exampleFr])),expected);checks++;
  // `example` garde son comportement (libellé localisé).
  assert.equal(themes.bills.example,locale==='fr'?'Consulter Factures':'Browse Bills');checks++;
  // Aucune autre différence avec la source HS1 sur les thèmes recopiés.
  for(const t of hs1.themes)assert.equal(themes[t.id].exampleFr,t.exampleFr);checks++;
  // HS1 plus ancien sans le champ (capture main b5b42a85) : null, jamais l'anglais ni une phrase inventée.
  const legacy=catalogProjection(read(`hs1-catalog-from-s24-sources.${locale}.json`),view);
  assert.ok(legacy.themes.every(t=>t.exampleFr===null));checks++;
  // Valeur forgée ou hors bornes : refus de toute la projection (fail-closed), comme les autres textes.
  for(const bad of ['',' ',{fr:'x'},42,'a'.repeat(201),'ligne\nsuivante']){
    const s=structuredClone(hs1);s.themes[0].exampleFr=bad;
    assert.throws(()=>catalogProjection(s,view),/catalog_source_unavailable/);checks++;
  }
}
console.log(JSON.stringify({suite:'catalog-example-fr',s24Sources:true,checks}));
