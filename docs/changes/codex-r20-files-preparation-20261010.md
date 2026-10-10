# R20 : lecture des fichiers via les propriétaires Gateway

Routes `GET /v1/files` et `GET /v1/files/content`, lecture seule, loopback, sur `agents.files.*` (six fichiers racine de `main`, IDENTITY/BOOTSTRAP ajoutés quand `get` réussit) et `sessions.files.*` (session principale `agent:main:main` prise dans `sessions.list`, jamais construite). Limites du propriétaire conservées (250 entrées, recherche 500, aperçu 256 Kio, images png/jpeg/gif/webp/avif), sans pagination maison ni limite de 5 Mio. Dates visibles dans les chemins et dans le texte. Cache `ControlReadPool`, réponse différée 200 jusqu'au résultat. NO_CAPABILITY définitif (voir `contracts/r20.md`).

Reprise Claude (10/10) : captures réelles de la session principale ajoutées aux fixtures, sélection par `agentId`/`isMain`, cache de découverte 10 min, sondes racine parallèles, recherche avec `browser.path:""`, masquage des cartes limité à 13-19 chiffres, recette par `settle()` de la base avec échec conditionnel.

Retour arrière : revert du lot ; déploiement et retour arrière automatiques par `companion-deploy.sh`. Paiement inchangé.
