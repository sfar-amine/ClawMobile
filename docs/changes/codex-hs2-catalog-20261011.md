# HS2 — Catalogue dérivé

[Contrat](../work/samantha-runtime/contracts/hs2.md) : `GET /v1/catalog` sert la projection HS1 du registre, avec la santé des routes installée, les gardes du propriétaire de paiement et l'atteignabilité de la vue de surface app. Ce qui n'est pas atteignable est grisé. Aucune lecture fournisseur ni bascule réseau, budget de 300 ms p95 tenu par un cache sans état. Retour arrière : revert.
