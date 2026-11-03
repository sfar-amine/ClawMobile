# Gateway : bail de base agent laissé par un PID réutilisé — 28 octobre 2026

Incident S24 du 28/10, de 19:41 à 19:50Z. Après le déploiement de 988c3b6d, le Gateway devait passer par une maintenance du Doctor. Le Doctor a refusé chaque démarrage avec le message « An agent database is in use … still open in process 6136 ».

Le processus OpenClaw 6136 était mort depuis 15:05Z, et Android avait donné son numéro à une autre app. OpenClaw n'accepte que ESRCH comme preuve de mort et ne peut pas lire `/proc` d'un autre uid : il a donc gardé le bail pour toujours. Conséquences : WhatsApp coupé 9 minutes et un déploiement terminé en `rollback_failed`. Le service a été rétabli à la main, en supprimant les deux lignes après sauvegarde.

Correctif : `gateway-start.sh` appelle `gateway-preflight.py agent-leases --apply` avant de lancer le Gateway. Seuls les baux dont le propriétaire répond EPERM sont libérés, c'est-à-dire un processus d'un autre uid, qui ne peut pas être OpenClaw. Un reçu est écrit dans `~/.openclaw/backups/agent-lease-recovery-*.json`, et la vérification d'intégrité de la base concernée est effacée, comme OpenClaw le fait pour un bail périmé. Rien n'est touché tant qu'un processus Gateway existe.

Retour arrière : revert puis redéploiement du core.
