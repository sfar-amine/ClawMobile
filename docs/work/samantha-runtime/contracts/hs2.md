# HS2 — `GET /v1/catalog` (vue dérivée)

Capability : `samantha.app.catalog` (registre HS1, `planned`, `companion_route` GET `/v1/catalog`, `read_only`).

## Ce que la route sert

La projection HS1 du registre canonique (`reporting.control_capability.catalog(locale, route_health, gates)`, playbooks), avec trois entrées en lecture seule :
1. **Santé des routes** installée : `~/.openclaw/skill-intelligence/route-health.json`. Une action dont une `routeHealthRefs` est `context_blocked` ou dont l'état effectif n'est pas sain est grisée (`reason: context_blocked`). C'est la logique de HS1, inchangée.
2. **Gardes du propriétaire de paiement** : `payments.capabilities()` (la projection servie par `GET /payments/capabilities`, lue en mémoire). `maxit.topup` est armée seulement si l'adaptateur live `maxit.topup` a `localOwnerValidated: true` ; cette valeur reflète la garde d'acceptation lue au démarrage et relue à l'exécution. La garde Topnet, à usage unique, n'est pas projetée par le propriétaire : « Payer Topnet » reste grisé (`acceptance_gate_unverified`). Aucun paramètre HTTP ni modèle ne peut armer une garde.
3. **Atteignabilité du graphe** : la vue de surface compilée de l'app, `~/.openclaw/capability-views/samantha_android.json` (même compilateur que les autres vues). Une capability absente de la vue ou d'atteignabilité autre que `native`/`delegated` est grisée (`capability_unreachable`). Une vue absente ou illisible grise toutes les actions adossées (`reachability_unknown`). Exception : `payment.owner_native` est `experimental`, donc hors des vues ; son parcours déterministe est gouverné par sa garde (point 2).

Les actions sans capability restent visibles et grisées (`capability: null`, `availability: soon`, « En cours de développement », DH1). Une action disponible porte sa requête canonique ; une action grisée a `request: null`. Paiement et transfert : `confirmationRequired: true`.

## Contrat (aligné sur `HomeCatalog.kt`, branche app `feature/samantha-ux-c11-20261009`)

`{version:1, locale, defaultPinned, themes:[{id,title,subtitle,icon,example,order,available,availability,groups:[{id,title,icon,actions:[{id,capability,title,kind,slots,request,risk,confirmationRequired,available,availability,reason,informationIcon,information,intent?}]}]}], generatedAt, inputs:{voiceMemo:{available:false,availability:"soon"}}, availabilitySource, surface?}`

- Pas d'`availability` ni de `computation` au premier niveau : l'app refuserait la réponse.
- `voiceMemo` est un objet, comme dans la fixture `catalog.v1.fr.json`, et reste désactivé jusqu'à HS8.
- Pas de badge tant qu'aucune source de reçu n'est qualifiée. Le champ est absent, jamais inventé.
- Locale : `?locale=fr|en` (envoyé par l'app), sinon `Accept-Language`. Tout autre paramètre renvoie 400.
- En-têtes : ETag fort et 304, `Vary: Accept-Language`, `Content-Language`, `Cache-Control: private, no-cache`.
- Garde : loopback seulement ; `Origin`, `Referer` et `Sec-Fetch-Site` sont refusés.

## Interdits vérifiés

Aucune lecture fournisseur (factures, payables, opérateur), aucune bascule réseau, aucun appel Gateway, aucun Graph ni exécuteur. Le test fait échouer toute autre commande enfant et tout appel `callOpenClawGateway`, `listPayables`, `laptopList` ou `allJobs`.

## Budget

300 ms p95. Une génération HS1 coûte environ 360 ms sur le S24 (mesuré le 11/10 : 655 ms à froid, puis 360 à 363 ms). Les lectures sont donc servies depuis la mémoire :
- cache partagé de 15 s dans le pool Control existant (vol unique, annulation, bornes 16 clés / 2 Mo) ;
- au-delà, la dernière projection est servie aussitôt pendant que le pool la recalcule, pendant 10 minutes au plus ;
- seule la toute première lecture après le démarrage attend la génération (enfant borné à 6 s) ; la recette `companion-acceptance.py` lui accorde son nouvel essai.

Mesures du test avec la latence S24 injectée : froid ≈ 390 ms, chaud p95 ≈ 90 ms (40 lectures concurrentes), périmé p95 ≈ 35 ms. La mesure physique sur le S24 se fera au déploiement, par Claude.

## Preuves

`openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11d/` :
- `hs2-catalog-sources.json` : vue `samantha_android`, santé des routes (état effectif) et présence des gardes, capturées en lecture seule sur le S24. SHA-256 identique sur le téléphone.
- `hs1-catalog-from-s24-sources.{fr,en}.json` : projection HS1 calculée sur ces sources (playbooks `main` b5b42a85) : 80 actions, dont 47 disponibles.

Test CI `scripts/test-catalog.cjs`.

## Retour arrière

Revert de la PR. Aucun store ni migration. Activation par Claude (`companion-deploy.sh`).
