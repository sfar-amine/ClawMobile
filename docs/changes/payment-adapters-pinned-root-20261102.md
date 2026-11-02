# Adaptateurs de paiement : chargement depuis l'épingle activée (02/11/2026)

Suite du lot « racine de code unique » (`single-code-root-20261102`). Amine a approuvé le 02/11/2026 d'y inclure
les adaptateurs de paiement, dans un commit séparé et minimal.

## Ce qui change

Seule la racine par défaut d'où les deux adaptateurs chargent leurs CLI :

- `maxitTopupLivePaymentAdapter.ts` : `uiRoot` par défaut passe de `~/.openclaw/workspace/ui-playbooks` au
  résolveur commun `playbooksRootFor("payment_maxit_topup", "billing/direct-runtime/maxit-topup-live-cli.mjs")`.
- `clicToPayLivePaymentAdapter.ts` (Topnet et fournisseurs ClicToPay) : `billingRoot` par défaut passe de
  `~/.openclaw/workspace/ui-playbooks/billing/direct-runtime` à la même racine résolue
  (`payment_clictopay`, fichier requis `billing/direct-runtime/billing-cli.mjs`).

Résolution : `~/.openclaw/runtime-ui-playbooks/current` (lien conservé, donc une activation ou un retour arrière
playbooks est suivi au prochain lancement de CLI). Si l'épingle manque, repli sur la copie de travail, sans jamais
refuser de démarrer, et événement `~/.openclaw/health/code-root/events/payment_*.json` que
`runtime-sync.sh --check` transforme en alerte. Les overrides `options.uiRoot` et `options.billingRoot` restent
prioritaires.

Inchangés : toute la logique de paiement, les portes, les montants, la confirmation, `GATE_FILE`/`GATE_VALUE`, les
portes d'acceptation, le parcours déterministe de la biométrie à la fin ; biométrie, OTP et 3-D Secure restent
humains.

Vérification du 02/11 (coordinateur) : dans l'épingle 47fdcca5 et la copie de travail 68fd7b02, chaque fichier
de paiement de `billing/direct-runtime`, `contracts/payment` et `package.json` a le même sha256, et
`billing/direct-runtime/node_modules` de l'épingle est un lien vers celui de la copie de travail. Aujourd'hui, la
bascule change donc seulement l'endroit d'où le code est chargé, pas le code.

## Tests

- `openclaw-plugin-mobile-ui/scripts/test-payment-adapter-root.cjs` (nouveau, inscrit dans
  `.github/workflows/ci.yml`) : résolution seule. Épingle présente → CLI chargées depuis l'épingle, sans alerte ;
  épingle absente → copie de travail et un événement par adaptateur ; overrides conservés. Les doubles ne
  répondent qu'à une lecture (devis Maxit, liste de factures) ; aucune exécution n'est appelée.
- Toujours verts : `test-maxit-topup-payment-adapter.cjs`, `test-clictopay-provider-adapter.cjs`,
  `test-topnet-live-payment-adapter.cjs`, `test-maxit-quote-real-shape.cjs`, `test-payment-core.cjs`,
  `test-payment-api.cjs`, `test-payment-budgets.cjs`, `test-payment-steps.cjs`, `test-payment-handoff.cjs`,
  `test-local-payment-intent.cjs`, `test-payment-pattern-boundary.cjs`, `test-run-payment-presentation.cjs`,
  `installer/termux-lite/test-payment-guard-invariance.py`.

## Recette après déploiement (démo seulement, jamais un paiement réel)

1. `ls ~/.openclaw/health/code-root/events/` : aucun `payment_maxit_topup.json` ni `payment_clictopay.json`.
2. Adaptateur `demo.confirmation` (référence `DEMO`, montant 0, « aucun paiement ») par le parcours app habituel :
   devis, confirmation propriétaire, état `confirmed`.
3. Facultatif, sans transaction : une lecture de factures Topnet par l'entrée canonique (liste des montants dus,
   aucune exécution). Aucun devis Maxit live : il passe par le fournisseur.
4. Si une recette live devait suivre plus tard, la répétition pré-paiement
   (`billing/direct-runtime/maxit-rehearsal.mjs`, règle du 11/10) passe avant.

## Retour arrière

Revert de ce commit seul, puis `companion-deploy.sh <commit>` : les adaptateurs relisent la copie de travail
comme avant. Le reste du lot n'en dépend pas.
