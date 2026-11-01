# Redémarrage de déploiement face à la Gateway OpenClaw 2026.10.9 (01/11/2026)

## Incident
Le 01/11 à 21:06 (Tunis), `companion-deploy.sh d55ad8f6` (#510) se termine en `rollback_failed`, avec le détail `runtime_sync_failed` et la raison `gateway_restart_failed`. Le retour arrière échoue de la même façon. C'est le premier déploiement depuis la bascule OpenClaw 2026.9.6 → 2026.10.9 (21:05).

## Cause exacte (vérifiée sur le S24)
`runtime-sync.sh` lance `openclawGatewayClient.js --deploy-restart`. Ce propriétaire n'arrête que les processus Gateway qu'il reconnaît :
- un enfant de son propre processus ;
- le pid du pidfile du Companion (`~/.openclaw/workspace/logs/companion-openclaw-gateway.pid`) ;
- un enfant de ce pid.

Or la Gateway 2026.10.9 (PID 22573, titre `openclaw-gateway`, ppid 1) a été lancée par `openclaw-upgrade` (`gateway-start.sh`, nouvelle session). Ce script n'écrit pas ce pidfile, et ses journaux vont dans `~/.openclaw/logs/`. Le pidfile désignait encore la Gateway 9.6 (26995), arrêtée par la bascule à 19:49 UTC.

Résultat : zéro cible, aucun SIGTERM (aucun arrêt dans le journal de la Gateway), puis « Stop command ran, but OpenClaw gateway is still reachable. » La CLI sort en 75 au bout d'environ 11 s. Ce n'est donc pas le budget de 240 s.

Preuves :
- rejeu de la sélection sur le S24 : `targets_as_companion: []`, `targets_as_deploy_cli: []` ;
- `POST /v1/runtime/restart` à 20:28:54 UTC : 500 en 11,05 s avec ce message, Gateway 22573 intacte.

Hypothèses écartées :
- **Délai.** L'échec arrive en 11 s, bien avant toute expiration.
- **Lancement de la 10.9.** `openclaw gateway` au premier plan ne fait pas de respawn en 2026.10.9 : le pid lancé est la Gateway. `OPENCLAW_STARTUP_TRIAGE=off` est bien présent. `CLAW_RUNTIME_ROOT` pointe sur le checkout, pas sur une release périmée.

## Correctif
- **Adoption.** Le propriétaire runtime adopte aussi la Gateway qu'il n'a pas lancée, avec la même identité que `openclaw-upgrade` (`gateway_pids`) :
  - le bail `state_leases/gateway-owner` d'OpenClaw, lu par `runtime_mode.py --gateway-owner-pid`, avec contrôle du `startedAt` pour écarter un pid réutilisé ;
  - ou le processus serveur Gateway (titre `openclaw-gateway` ou `openclaw gateway` suivi d'options), lancé sur le même répertoire d'état.

  Ne sont jamais adoptés : une Gateway de préprod (autre répertoire d'état), les wrappers shell et une CLI telle que `openclaw gateway status`.
- **Arrêt gracieux borné.** SIGTERM, puis attente jusqu'à 15 s (`CLAWMOBILE_RUNTIME_STOP_GRACE_MS`) que le processus disparaisse et que le port se ferme. Avant, un SIGKILL partait au bout de 750 ms ; la 10.9 retire ses plugins avec des délais de 5 s. Les workers instantanés avant l'arrêt (spawn-broker, lecteurs sqlite) qui survivent sont ensuite arrêtés, identifiés par leur date de démarrage.
- **Nettoyage au démarrage.** Une Gateway dont l'environnement prouve un autre répertoire d'état n'est plus ni attendue ni tuée.
- **Diagnostic.** La CLI écrit son verdict sur stderr (`{"component":"runtime-restart",...}`), avec cibles, adoptions et workers en compte, sans ligne de commande ni valeur d'environnement. `runtime-sync.sh` le verse dans le journal du déploiement au lieu de `/dev/null`.
- **Budget.** `RUNTIME_SYNC_RESTART_TIMEOUT_S`, 360 s par défaut au lieu de 240. Le pire cas devient bail 3 s + arrêt 15 s + attente 10 s + grâce 30 s + démarrage 180 s + catalogue 20 s = 258 s, alors qu'il dépassait 240 s. Pour mémoire, à la bascule, la 10.9 a répondu à la santé 70 s après son démarrage et s'est déclarée prête à 92 s.

## Routes
`POST /v1/runtime/restart`, `/v1/runtime/stop` et `/v1/runtime/start` : même contrat. Le message d'échec précise maintenant le nombre de cibles. Budget client inchangé côté health-manager (230 s) ; 360 s côté `runtime-sync`. Route owner sans capability, inchangée.

## Tests
- `scripts/test-gateway-adopt-restart.cjs` (nouveau, inscrit dans `ci.yml`) :
  - rejeu des lignes S24 : zéro cible avant le correctif ;
  - Gateway étrangère adoptée par son répertoire d'état et par le bail, avec vrai flock hérité ;
  - arrêt gracieux au-delà de 750 ms, worker orphelin arrêté ;
  - Gateway de préprod intacte, pidfile réécrit.
- `test-runtime-mode.py` : lecteur du bail avec le schéma S24, pid réutilisé ou mort refusé.
- `test-qa-deploy-gateway-restart.cjs` : adapté à la ligne de verdict.

## Fixtures
`openclaw-plugin-mobile-ui/fixtures/s24-2026-11-01-deploy-restart-1009/` : captures S24 en lecture seule, nettoyées (home en `~`, hôte et UUID masqués).

## Retour arrière
Revenir sur ce commit, puis lancer `companion-deploy.sh` vers le commit précédent. Tant qu'une Gateway lancée hors du Companion tourne, un déploiement qui change le plugin échouera alors de nouveau en `gateway_restart_failed`.
