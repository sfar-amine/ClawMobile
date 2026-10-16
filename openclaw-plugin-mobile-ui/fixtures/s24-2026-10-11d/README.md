# Captures S24, 11/10/2026 — HS2

| Fichier | Source | Contenu |
|---|---|---|
| `hs2-catalog-sources.json` | S24, 11/10 09:23, runtime `fe5e5b11`, playbooks `b5b42a85`, lecture seule | Vue `~/.openclaw/capability-views/samantha_android.json` (id, reachability), `~/.openclaw/skill-intelligence/route-health.json` réduit à l'état effectif (state, context_blocked, last_failure_class, suppress_until), présence des fichiers de garde de paiement (contenu non lu). SHA-256 identique sur le S24 : `7d0458c0622f3b5de9d3ad16919add0ef29817cd6cb829441cc6c2310b8d9148`. |
| `hs1-catalog-from-s24-sources.{fr,en}.json` | `samantha-ui-playbooks` main `b5b42a85`, `reporting.control_capability.catalog(locale, route_health, gates, now=capture)` | Projection HS1 calculée sur les sources ci-dessus, avec la garde Maxit armée comme la projette le propriétaire de paiement. |
| `hs1-catalog-example-fr-from-s24-sources.{fr,en}.json` | `samantha-ui-playbooks` `feat/catalog-example-fr-20261011` `63e9c221`, même appel, même `now` (capture), mêmes sources | Même projection HS1 avec `themes[].exampleFr` (phrase française à dire, identique en FR et EN ; `null` pour Portefeuilles et Recherche web). |

Mesure du 11/10 sur le S24 : une génération HS1 avec santé des routes prend 655 ms à froid, puis 360 à 363 ms. Capture faite par Claude via le connecteur Claw : aucun paiement, aucune consultation opérateur, aucun appel de modèle.
