# G4 (fichier 35) — Déploiements

GET /v1/control/deploys?limit=20 est une lecture native loopback, refusant Origin, Referer et Sec-Fetch-Site. Budget 0,5 s ; limit de 1 à 50, paramètres inconnus/dupliqués refusés. Aucune mutation ni Gateway.

Propriétaires confirmés sur S24 : ~/.openclaw/deploys/companion-YYYYMMDDTHHMMSS.json (companion-deploy.sh) et app-…json (install-from-ci.sh). Le dossier réel contient 15 reçus Companion et 7 app ; la fixture conserve 8 échantillons nettoyés. Première collecte metadata 41,76 ms ; capture enrichie publiée 10,93 ms. Version 1, at UTC, state, target/previous (Companion), commit (app), acceptance.checks (Companion). Les détails et routes libres ont été retirés sur le S24 avant transport.

Réponse : schemaVersion:1, state ok|partial|unavailable, items et issues (codes fixes). Chaque item : kind, state, target, previous, at, appVersion, checksCount, failedChecks et rollback. Un échec est identifié par le numéro du contrôle et son code HTTP ; aucun contenu de recette ni chemin libre n'est exposé. at est la date UTC du reçu terminé, pas la date Git. previous/checksCount/failedChecks sont null pour les reçus app sans source. appVersion est null sauf detail conforme à la grammaire numérique du propriétaire ; les captures présentes ne prouvent pas de version app et rendent null. Ne pas déduire de version depuis Git.

Lecture protégée O_NOFOLLOW, fichiers réguliers <=256 Kio, dossier ouvert et enfants ancrés sur son descripteur. Au plus 10 000 entrées inspectées, 100 reçus ouverts ; ordre par horodatage canonique du nom, puis date de reçu pour l'affichage. Au-delà : partial et code fixe, aucune prétention d'historique complet. Cache mémoire 1 s, rafraîchissement unique partagé, aucun store.

G5 réutilise latestCompanionDeploymentAt(target) du même module : date du dernier reçu Companion deployed correspondant à la version ; absent, ambigu ou scan partiel => null. Aucun reçu refused/rollback/app ne prouve une date de déploiement Companion.

Capability samantha.app.control.deploys planned, GET /v1/control/deploys budgetMs=500, lecture sans confirmation. Activation V6/qualification par Claude.

Tests : fixtures réelles nettoyées, 600 reçus dérivés explicitement de leur forme, collecte froide sous 500 ms, 10 lectures concurrentes/une collecte, gardes HTTP, limite, symlink/dossier/JSON corrompu/surdimensionné, absence de contenu privé, fichiers inchangés. Recette /control/deploys?limit=20 : 0,5 s. Retour arrière : revert des deux PR ; aucun déploiement Codex.
