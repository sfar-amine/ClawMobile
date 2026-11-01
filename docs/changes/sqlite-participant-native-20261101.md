# Participant de session écrit nativement, sans Worker SQLite jetable — 1er novembre 2026

Mesure S24 (OpenClaw 2026.9.6) : à chaque tour d'agent, `recordSessionParticipantBestEffort` → `recordSessionParticipantInWorker` → `runSessionCollaborationWrite` prend l'admission d'écriture de la base agent, puis ouvre un Worker SQLite jetable (création, ouverture, liaison, fermeture) pour une seule écriture de participant. L'admission reste tenue environ 2 s (profil du 31/10 : 2,02 s ; Gateway fraîche le 01/11 : ~7,7 s). Les écritures de session du même tour (`session.entry-replacements`, `session.maintenance.plan`) attendent derrière : le journal de la Gateway signale « slow SQLite session write » avec 1,4 à 3,4 s d'attente de file à chaque tour.

La même fonction sait déjà écrire le participant sans Worker : pour une base incognito, elle appelle l'écrivain natif d'OpenClaw `recordSessionParticipant` (`session-sharing-store.native`), qui publie lui-même la mise à jour du cache participant et l'événement de cycle de vie.

Changement, dans le jeu `memory-retrieval-warm` du propriétaire de compatibilité (une entrée par version épinglée) :
- 2026.9.6, `dist/session-accessor-DLYTHSBj.mjs` (S24 = npm, `756d3a58…`) → `d70d8324…` ;
- 2026.10.9, `dist/session-accessor-C3ljJ974.mjs` (candidat S24 = npm, `c000b950…`) → `bed9c5d2…`.

Juste après la branche incognito (inchangée) et avant la capture d'exécution du chemin Worker, la commande `participant` d'une base fichier passe par `native(capturedScope)` dans la même admission d'écriture (`runOpenClawAgentWriteAdmission(…, true)`). La base est d'abord admise par le chemin asynchrone habituel (`withOpenClawAgentDatabaseAsync` en 2026.9.6, `withOpenClawAgentDatabaseRuntime` en 2026.10.9, seule fonction de ce type importée par le module), avec la même vérification `assertCurrent` avant l'écriture. Les autres commandes de collaboration gardent leur Worker.

Écart avec le correctif proposé par l'enquête : même code, mais placé après le `return` de la branche incognito au lieu d'avant. Les bases incognito gardent ainsi exactement leur chemin actuel (sans passage par l'admission asynchrone de base). Les empreintes corrigées diffèrent donc de celles de la proposition (`2b1f455b…`, `af8437ad…`).

Tests : sur les deux modules capturés, le test vérifie l'empreinte corrigée épinglée, la position de la branche et `node --check`. Il exécute aussi la fonction corrigée elle-même, avec les propriétaires OpenClaw enregistrés : le participant est écrit nativement dans l'admission et la base admise, sans Worker ; un tour périmé est refusé avant l'écriture ; `add` garde son Worker ; la branche incognito est inchangée. Sur les modules non corrigés, le même banc montre bien le Worker. La variante 2026.10.9 s'applique et se retire avec le reste du jeu.

Limites :
- le gain attendu n'est pas mesuré ; le banc coldbench et les attentes « slow SQLite session write » sont à comparer après déploiement ;
- l'écriture du participant tourne désormais sur le fil principal de la Gateway : quelques petites requêtes dans une transaction immédiate, avec le délai d'occupation de 5 s commun à toutes les écritures natives. Un verrou tenu par une autre connexion bloquerait la boucle d'événements au lieu d'un Worker ;
- les autres Workers du tour (transcript de session, store SQLite, rappel mémoire) et les autres commandes de collaboration ne sont pas traités ;
- la variante 2026.10.9 n'est vérifiée que sur le module npm/candidat, avec des propriétaires simulés ; l'import réel sur le candidat n'a pas été fait.

Retour arrière : `companion-deploy.sh` du commit précédent, ou `--patch-set memory-retrieval-warm --rollback` puis redémarrage de la Gateway.
