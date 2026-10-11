# HS3 — Présentation des reçus dans les runs

Le [contrat](../work/samantha-runtime/contracts/hs3.md) transporte `presentation`, `understood` (slots opérateur, montant, bénéficiaire ; ligne « Compris : … »), `failure` (dernière étape tracée, `notDone` seulement prouvé) et les alternatives Harness du Graph jusqu'aux runs existants et à `GET /v1/runs/{id}`. Lecteurs fermés en Python et TypeScript, testés sur captures S24 réelles, dont les `PaymentRecord` terminaux. Effet de débit toujours `unknown`. Aucun fichier de paiement modifié. Retour arrière : revert.
