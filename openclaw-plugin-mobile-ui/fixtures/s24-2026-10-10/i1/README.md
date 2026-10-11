# I1 — captures natives existantes

Copie byte-identique de core PR #70, commit `51c1266b5b8b2f224f39e3b525385ab5335557b0`. Aucune nouvelle capture ni effet S24.

Origine : lectures en lecture seule sur le S24 le 10/10, nettoyage avant transport documenté dans `_capture` et `p0-3/README-native.md` de cette PR. Le résultat natif automations est la source du handler Control, pas une réponse HTTP réinjectée à sa place. Le registre de runs est un sous-ensemble réel terminal hors paiement ; aucun journal ni confirmation ni requête de paiement inclus.

- `native-automations.json` : SHA256 `1e8e24310c5fcab479e66f7e0396d6f9915f4031ba738e2f8f55023ffc4fb930`.
- `native-runs-registry.json` : SHA256 `8f67c049969536dea2f7878b4de9e586cfa73eb3f52893e193b90bee7c645dba`.

Les tests de changement sont des variations explicitement déclarées de ces formes réelles. Aucune recette physique ni activation de la branche I1 déduite.
