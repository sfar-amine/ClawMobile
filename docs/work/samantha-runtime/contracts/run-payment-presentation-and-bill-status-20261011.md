# Run de paiement et état des factures (11/10/2026)

Branche `fix/run-presentation-bills-20261011`, depuis `runtime/samantha-companion-private`.

Constats à l'origine : captures S24 de core #176, en lecture seule.
- `fixtures/s24-2026-10-11/hs3/failed-payment-handoff.json` ;
- `fixtures/s24-2026-10-11/hs2/qualified-receipts-owner.json`.

Les deux lots sont des **projections à la lecture**. Ils n'ajoutent ni store, ni registre, ni routeur, ni scheduler, ni démon.

Le parcours de paiement n'est pas touché : adaptateurs, `paymentCore`, start, confirm et retour banque restent tels quels.

## 1. Run qui passe la main à un paiement

**Constat S24.** Un run `payment.owner_native` dont la demande de paiement échoue garde ces valeurs :
- `state=done` ;
- `presentation.status=info` ;
- `understood.capability=null`.

L'échec n'existe que dans `paymentRequests[]`. L'app affiche alors « Interprétation non fournie par le serveur ».

**Lien entre les enregistrements existants de `runs.json`.**
- `paymentRequests[].ownerConfirmationId` → `ownerConfirmations[].id` ;
- `ownerConfirmations[].intent.origin.id` → `runs[].decision.requestId`, ou `runId` / `clientRunId`.

Une demande créée directement pour le run compte aussi : `draft.origin.id` vaut alors l'un de ces identifiants. Quand plusieurs demandes sont liées, la plus récente l'emporte.

**Projection** (`runPaymentPresentation.ts`, appliquée dans `readCompanionRunRegistry`).
- **Stockage.** Le résultat est porté par un champ dérivé `paymentPresentation`, retiré à chaque écriture. Le fichier ne change donc pas, et le budget d'octets des runs non plus.
- **Routes servies.** `GET /v1/runs/:id`, les listes de runs, les pages de conversation et `progress.steps`.

**Champs exposés dans `presentation`** (le run garde son `state`) :

| Champ | Valeur |
|---|---|
| `understood.capability`, `meta.capability` | `decision.capability`, par exemple `payment.owner_native` |
| `understood.label` | Libellé fermé par adaptateur : « Recharger mon numéro » / « Top up my number » (`maxit.topup`, ou l'intention `telecom.orange.topup_own_number`), « Payer la facture » / « Pay the bill » (Topnet, STEG, SONEDE). Sinon, le libellé stocké. |
| `understood.slots` | `operator` / `provider` selon l'adaptateur. `amountTnd` vient de `quote.amountMinor` / `decimals` (TND), sinon de `decision.parameters`. `beneficiary` vaut `owner` pour `*_own_number`, sinon le bénéficiaire est masqué en `•• NN`. |
| `understood.text` | « Compris : Recharger mon numéro · Orange · 5 DT · ta ligne » |
| `status` | `error` pour `failed`, `blocked`, `effect_unknown`, `expired`, `cancelled` ; sinon `info` |
| `title` | « Paiement non abouti » / « Paiement confirmé » / « Résultat à vérifier » |
| `payment` | `{state, reasonCode, stepId}`, avec l'état de la demande (`awaiting_owner`, `executing`, `requires_bank_action`, `confirmed`, `demo_confirmed` ou un état d'échec) |
| `failure` | `{step, stepId, reason, reasonCode, notDone}`. `stepId` est la dernière étape tracée connue de HS3, par exemple `execution_error`, ou `unknown`. |
| `effect.debited` | Toujours `unknown` |

**Valeur de `notDone`.** Elle vaut `payment_not_submitted` dans trois cas seulement :
- `blocked` / `payment_not_submitted`, puisque `paymentCore` n'accepte `blocked` que si l'adaptateur prouve qu'aucune soumission n'a eu lieu ;
- aucun enregistrement de paiement ;
- `blocked`, `expired` ou `cancelled` avec `executorAttempts=0`.

Dans tous les autres cas, elle vaut `unknown`.

**Étapes.** Dans `progress.steps`, l'étape `execute` passe à `failed` si le paiement a échoué, et à `running` tant que le paiement est en attente ou en cours.

## 2. État des factures dans `GET /v1/catalog`

**Sources existantes, en lecture seule, sans appel fournisseur.**

1. **Reçus du pont** `~/.openclaw/remote-bridge/requests/*.json`, retenus si toutes ces conditions sont réunies :
   - `state=completed` ;
   - `result.success=true` ;
   - `result.capability=billing.utility.fast_path` ;
   - `execution.state=completed` et `exit_code=0` ;
   - `execution.result.schema_version=2`.

   Pour chaque fournisseur, le reçu donne :
   - `status` et `coverage_complete` ;
   - `has_pending` et `pending_count` ;
   - `total_pending` et `items[].due_date` ;
   - `checked_at`.
2. **`paymentRequests` confirmés** (`state=confirmed`, mode `live`, adaptateur `steg` / `sonede` / `topnet`, TND), postérieurs au dernier contrôle.

**Règles de calcul.**
- **Impayé.** `has_pending=true` donne `unpaid`. Le montant n'est donné que si la couverture est complète. L'échéance est la plus proche.
- **Rien à payer.** `has_pending=false` avec une couverture complète donne `paid` (« Aucun impayé »).
- **Autres cas.** Ils donnent `unknown`, avec `reasonCode` égal au `reason_code` ou au `status` du fournisseur.
- **Paiement confirmé après le contrôle.** S'il correspond au montant impayé, ou si le montant est inconnu, l'état devient `paid`, avec `source=payment_request`. Sinon, l'état devient `unknown` / `payment_after_check`.

**Contrat lu par l'app** (`HomeCatalog.kt`, commit `b986ee53`).
- **`themes[].groups[]`** (groupes `steg`, `sonede`, `topnet` qui portent une action `billing.utility.fast_path`) reçoivent `status`. L'action de lecture de facture du groupe porte le même objet.

```json
{"provider":"steg","state":"unpaid","amountMinor":84300,"decimals":3,"currency":"TND","dueDate":"2026-10-31",
 "checkedAt":"2026-10-06T10:41:10Z","source":"bridge_receipt",
 "text":"Impayée · 84.300 DT","tone":"alert","at":"2026-10-06T10:41:10Z"}
```

  - `state` vaut `unpaid`, `paid` ou `unknown`.
  - `amountMinor` (millimes) et `dueDate` (AAAA-MM-JJ) sont optionnels.
  - `source` vaut `bridge_receipt` ou `payment_request`.
  - L'app lit `text`, `tone` (`alert` ou `info`), `source` et `at`. `at` est égal à `checkedAt` et sert à l'affichage de fraîcheur (« vérifié il y a 5 j · peut-être plus à jour »).
  - Les textes possibles sont : « Impayée [· X DT] », « Aucun impayé », « Payée · X DT » et « État non vérifié ». En anglais : Unpaid, Nothing due, Paid et Status not verified.
- **`themes[].badge`** existe uniquement s'il y a au moins un impayé : `{tone:"alert", count, source:"bridge_receipt", at, text:"1 impayée"}`.
- **Sans source,** il n'y a ni `status` ni `badge` : rien n'est inventé.

**Budget `/catalog`** : 0,3 s à chaud, inchangé (`companion-acceptance.py`).
- **Hors du chemin des requêtes.** Le lecteur ne tourne que dans la génération partagée du catalogue (pool Control, 15 s, servie depuis la mémoire).
- **Coût borné.** Chaque passe est bornée à 1,5 s. Les reçus sont lus du plus récent au plus ancien.
- **Mémo en mémoire.** Il garde les reçus terminaux déjà lus et ne retient que les noms encore présents. Un reçu non terminal est relu à la passe suivante.
- **Mesures** (CI, 50 000 reçus, reçu de facture le plus ancien) :
  - 10 passes pour l'atteindre ;
  - 124 ms par passe une fois le mémo rempli ;
  - p95 à chaud de 6 ms.

  Sur le S24, avec 7 138 reçus le 10/10, le chiffre attendu est de 1 à 2 passes.
- **Limite.** Un résultat compacté en artefact par le pont (`compactResult`, au-delà de la limite en ligne) n'est pas lu.

## Tests (inscrits dans `ci.yml`)

- `scripts/test-run-payment-presentation.cjs` porte sur les chaînes réelles. Les 2 chaînes `blocked` sont liées. Les états `effect_unknown` et `failed` sont projetés via la décision réelle. Le test couvre aussi `expired` par lien direct, la route HTTP et la liste, ainsi qu'une écriture du registre : fichier sans champ dérivé, paiements intacts.
- `scripts/test-catalog-bill-status.cjs` porte sur le reçu réel de facture, reconstitué à partir des âges de la capture. Le test couvre la règle de paiement confirmé, le contrat de l'app, le badge, la route sur 50 000 reçus et le budget à chaud.

## Retour arrière

Revert du commit. Aucune donnée n'est migrée ni écrite.
