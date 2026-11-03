# Worker de rappel mémoire gardé chaud — 31 octobre 2026

Mesures S24 (OpenClaw 2026.9.6) : un tour du cerveau passe 3,6 à 11 s dans la préparation de la Gateway, dont 0,17 s seulement dans le plugin Samantha. Pendant un tour après une pause, la Gateway démarre `memory-search.worker.js` juste après le catalogue d'outils, avant le modèle. Le pool de rappel de `memory-core` n'a pas de `idleTimeoutMs` : `WorkerTaskPool` le retire après 60 s, donc presque chaque tour vocal paie ce redémarrage (~2,5 s sur les 4 cœurs du téléphone). Un appel de lecture léger avant le tour (`chat.history`, `sessions.list`) ne réchauffe rien ; OpenClaw 2026.10.9 ne change pas ce point.

Changement : un cinquième jeu du propriétaire de compatibilité existant (`openclaw-compat/whatsapp-network-recovery.py --patch-set memory-retrieval-warm`), épinglé par empreinte sur le module public `dist/manager-cpu-worker-runtime-Egp8qeu_.mjs` (identique sur le S24 et dans le paquet npm). Seul le pool `retrieval` reçoit `idleTimeoutMs: 18e5` (30 min) ; le pool d'indexation est inchangé. Comme le délai reste supérieur à zéro, le pool garde son retrait sur pression mémoire critique.

Branchement, comme les autres jeux :
- `runtime-sync.sh` applique le jeu au déploiement et redémarre la Gateway s'il vient d'être appliqué ; `--check` le contrôle toutes les 30 min (`openclaw:memory_retrieval_warm`).
- `gateway-start.sh` suit la propriété du checkout (application, ou retour arrière depuis une release qui ne le possède plus) ; un refus ne bloque pas le démarrage.
- `companion-deploy.sh` défait le jeu au retour arrière si le commit précédent ne possède pas ce manifeste à l'octet près.

Fixture : `fixtures/s24-2026-10-31-memory-retrieval-warm/` (module capturé, mesures nettoyées : étapes du journal Gateway, workers démarrés pendant un tour, ticks CPU par thread). Test : `installer/termux-lite/test-memory-retrieval-warm.py`, inscrit en CI.

Limites : le gain attendu (~2 s sur un tour après une pause) est déduit des mesures et n'est confirmé que par la mesure avant/après sur le S24. Le worker gardé occupe de la mémoire, mesurée après déploiement. Le redémarrage de `sqlite-store.worker.js` (~2,2 s d'attente SQLite) n'est pas traité ici.

Retour arrière : `companion-deploy.sh` du commit précédent, ou `--patch-set memory-retrieval-warm --rollback` puis redémarrage de la Gateway.
