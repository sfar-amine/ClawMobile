# HS3 — Transport de la présentation des reçus dans les runs

Ce lot transporte la présentation produite par le Capability Graph (playbooks #72, contrat `samantha-ui-playbooks/docs/work/samantha-runtime/contracts/hs3.md`) jusqu'au run Companion existant (`runs.json`) et à sa lecture `GET /v1/runs/{id}`. Aucun fichier de paiement, de confirmation, d'exécuteur ou de l'app n'est modifié. Aucun nouveau store, route ni routeur.

## Chemin

1. Le Graph renvoie `presentation`, `understood`, `failure`, `alternatives` (la shortlist vient du Harness, sans reclassement).
2. `model-fast-path.py` garde une présentation **validée** par `receipt-presentation-read.py` (lecteur fermé) au lieu de ne garder que `execution.result`. `_display_text` affiche la ligne « Compris : … » quand une capability est comprise, puis le titre et `spoken`. Sur une confirmation de paiement ouverte (handoff déclaré), la présentation du Graph accompagne la réponse (« Compris : Recharger mon numéro · Orange · 5 DT · ta ligne ») ; un handoff en échec garde le repli d'erreur générique.
3. `intent.ts` transmet les métadonnées à `settleSubmittedRun` ; `runs.ts` les stocke bornées et les revalide à la relecture (`receiptPresentation.ts`).

## Sous-contrat accepté (lecteurs Python et TypeScript)

- `status` info/error, `rows` vide, `primary` done, `effect.debited` = `unknown` seulement.
- `understood.slots` : `operator` (orange/tt/zain), `provider` (topnet/steg/sonede), `amountTnd` (`^\d{1,6}(\.\d{1,3})?$`, > 0), `beneficiary` (`owner` ou valeur masquée `•• 482`). Toute autre clé ou valeur est retirée. `understood.text` (≤ 240) est conservé s'il passe le filtre.
- `failure` : `step` et `reason` obligatoires ; `stepId` seulement dans la liste fermée des étapes (Graph et jalons `PaymentRecord`) ; `notDone` = `{code:"unknown"}` ou `{code:"payment_not_submitted"|"not_started", text}`. Un `notDone` inconnu (par exemple « rien n'a été débité ») est retiré.
- `alternatives` : ≤ 3 capabilities uniques, différentes de la sélection, dans l'ordre reçu.

## Décision publique

`GET /v1/runs/{id}`, la liste des runs et la réponse de soumission portent aussi `decision`, projection fermée de la décision v2 stockée, sans recalcul : `type`, `capability`, `intent`, `target`, `risk`, `confirmationRequired` et `parameters` validés (`amountTnd` au format de l'extracteur, `beneficiary` seulement masqué). Plan, exécuteur, hash et autres champs bruts ne sont jamais exposés. L'app s'en sert pour « Compris : … » et « Ce n'est pas ça » quand une recharge avec montant est résolue en `risk == "read"` (core #143).

## Preuves

- `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11c/hs3-payment-terminal-records.json` : `PaymentRecord` terminaux réels du S24, lus en lecture seule dans `runs.json` (`paymentRequests`), réduits aux champs publics de `paymentView()`.
- `…/s24-2026-10-11c/hs3-presentations-from-captures.json` : sorties du module playbooks sur les captures réelles (`s24-2026-10-11/`, core #129) et sur ces `PaymentRecord`.
- `scripts/test-receipt-presentation-read.py` et `scripts/test-receipt-presentation.cjs` (CI) : lecteur fermé, ligne « Compris », `notDone` seulement prouvé, transport `submitIntent` → `runs.json` → `GET /v1/runs/{id}` → relecture par un processus neuf.

## Limites

- Pas de formateur métier (rows, success) : repli générique.
- Le montant n'apparaît qu'avec `decision.parameters` (38 E1).
- Aucune nouvelle route : la lecture du détail d'un run existe déjà (budget READS inchangé).

## Retour arrière

Revert de la PR ; les anciens runs restent lisibles. Activation par Claude via `companion-deploy.sh`, après playbooks #72.
