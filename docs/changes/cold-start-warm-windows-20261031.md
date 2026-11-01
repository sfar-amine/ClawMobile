# Fenêtres chaudes du premier tour portées à 12 h — 31 octobre 2026

Remesure S24 après core#492 (Gateway démarrée depuis plus d'une heure, 5 tours espacés de 90 s) : les tours 2 à 5 passent à 3,7–5,1 s (médiane 3,85 s contre 5,15 s avant), et 0,4–0,5 s entre le catalogue d'outils et le démarrage du modèle. Le premier tour, plus de 30 min après le précédent, reste à 7,6 s :
- la poignée de la base agent (79 Mo) avait été fermée par la fenêtre commune de 30 min (`SQLITE_IDLE_HANDLE_TTL_MS`). Sa réouverture met en file une vérification d'intégrité (`quick_check`), et l'écriture de session attend 2,6 s ;
- le worker de rappel, retiré après 30 min, redémarre (3,2 s entre catalogue et démarrage).

Changement, dans le même jeu `memory-retrieval-warm` du propriétaire de compatibilité :
- `idleTimeoutMs` du pool de rappel passe de 18e5 à 432e5 (12 h) ;
- `SQLITE_IDLE_HANDLE_TTL_MS` passe de 18e5 à 432e5 dans `dist/sqlite-handle-lifecycle-dWd9h3ii.mjs`. Ce module public est identique à l'octet en 2026.9.6 et en 2026.10.9, et la même entrée épinglée figure dans la variante 2026.10.9.

Le correctif 30 min déjà déployé est déclaré comme prédécesseur épinglé : `--apply` le fait passer à 12 h, `--rollback` revient à l'original, et tout autre état est refusé sans écriture. `runtime-sync.sh` redémarre la Gateway quand le jeu vient d'être appliqué.

Limites : le gain attendu sur le premier tour après une longue pause n'est confirmé que par un banc avec une pause de plus de 30 min après déploiement. Les poignées et le worker restent en mémoire jusqu'à 12 h : le RSS mesuré était de 923 Mo au repos et de 962 Mo à chaud, il sera remesuré. Un redémarrage de la Gateway repart à froid.

Retour arrière : `companion-deploy.sh` du commit précédent, ou `--patch-set memory-retrieval-warm --rollback` puis redémarrage de la Gateway.
