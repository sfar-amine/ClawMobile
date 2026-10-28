# Vue mémoire en fin de prompt système — 28 octobre 2026

Recette du 28/10 sur le S24, après le déploiement de 3f4758c6. À chaque tour WhatsApp, le premier appel au modèle ne reprenait du cache que 14 976 tokens, et relisait 54 000 à 57 000 tokens sans cache. Avant ce déploiement, à 13:47, il en reprenait 63 232. Même deux tours avec une vue mémoire identique ratent le cache.

Cause : la vue mémoire partait avec le message courant (`prependContext`), et OpenClaw ne l'enregistre pas dans l'historique. Au tour suivant, le message précédent est donc renvoyé sans elle : il ne correspond plus à la requête mise en cache, et la chaîne de cache casse à chaque tour.

Correction : la vue mémoire ferme le prompt système (`appendSystemContext`), juste avant l'historique. Les règles stables l'ouvrent toujours (`prependSystemContext`).
- Tant que la mémoire ne change pas, tout le début du prompt reste en cache.
- Quand elle change, seul l'historique est relu.

Le retrait des doublons SOUL.md / AGENTS.md sur WhatsApp est conservé. Le Companion garde sa partie stable et reçoit la vue mémoire de la même façon.

Retour arrière : revert de ce commit, puis redéploiement par `companion-deploy.sh`.
