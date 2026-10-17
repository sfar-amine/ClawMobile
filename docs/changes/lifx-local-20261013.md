# LIFX local — runtime

Adaptateur UDP `lifxLocal.ts` (LAN wlan0, Get*/Set* LIFX, relecture de vérification, ledger `nativeOperation`) et quatre routes Companion owner : `GET /v1/lighting/discover`, `GET /v1/lighting/{device_id}/state`, `GET /v1/lighting/{device_id}/diagnostics` (budget 3 s chacune) et `POST /v1/lighting/{device_id}/state` (refusée sans en-tête propriétaire). Lignes ajoutées à `companion-acceptance.py`. Capabilities `samantha.app.lighting.*` dans le registre playbooks.

Tests `test-lifx-local.cjs` et `test-lifx-route.cjs` (inscrits dans `ci.yml`), fixtures réelles du S24 : lecture du 13/10 (`lifx-a19-s24-20261013.json`) et découverte vide en lecture seule du 17/10 (`lifx-discover-s24-20261017.json`). Aucune écriture réelle de lampe ; recette live avec Amine après déploiement. Contrat : [58 — LIFX local](https://github.com/sfar-amine/samantha-ui-playbooks/blob/main/docs/work/samantha-convergence/58_LIFX_Local.md).
