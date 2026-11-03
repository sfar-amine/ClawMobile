# Redémarrage de déploiement face à la Gateway OpenClaw 2026.10.9 (S24, 1er novembre 2026)

Captures en lecture seule sur le S24 de prod, entre 20:25 et 20:31 UTC, après l'échec du déploiement `d55ad8f6` (reçu `companion-20261101T210607`, `runtime_sync_failed`, raison `gateway_restart_failed`).

Contenu de `capture.json` :
- la ligne `ps -ef` de la Gateway 2026.10.9 (titre `openclaw-gateway`, ppid 1), lancée par `openclaw-upgrade 20261101T204745` ;
- quelques workers enfants et une CLI courte ;
- son répertoire d'état (`OPENCLAW_STATE_DIR`) ;
- la ligne `state_leases` / `gateway-owner` d'OpenClaw, avec le schéma de la table ;
- le pidfile du Companion, qui pointait encore vers la Gateway 9.6 arrêtée ;
- le rejeu de la sélection d'arrêt, qui donne zéro cible ;
- la réponse réelle de `POST /v1/runtime/restart` : 500 en 11 s, Gateway intacte.

Nettoyage : chemins du home abrégés en `~`, nom d'hôte et UUID du bail remplacés par des marqueurs. Aucune variable d'environnement hors `OPENCLAW_STATE_DIR` et `OPENCLAW_STARTUP_TRIAGE`.

Utilisé par `scripts/test-gateway-adopt-restart.cjs` et `installer/termux-lite/test-runtime-mode.py`.
