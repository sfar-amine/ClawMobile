# Watchdog des services cœur : une Gateway vivante sans port est relancée — 1er novembre 2026

Constat (S24, lecture seule, 01/11) :
- Une Gateway OpenClaw dont le démarrage ou la relance en processus échoue peut rester vivante sans serveur (« Process will stay alive ») : port 18789 fermé, verrou libéré. Possible en 2026.9.6 lors d'une relance, et en 2026.10.9 dès le premier démarrage.
- Le watchdog du Companion rattrape ce cas (sonde TCP toutes les 15 s, puis `startRuntime`).
- `core-services-watchdog.sh` ne regardait que `pgrep -f openclaw-gateway` et croyait la Gateway vivante ; `samantha-health-manager.sh` ouvre un incident mais ne relance pas (propriétaire : Companion). Companion arrêté = personne ne relance.

Correctif, dans `core-services-watchdog.sh` (propriétaire existant, aucun démon nouveau) :
- Un processus Gateway présent ne suffit plus : le port de `gateway-start.sh` (18789 par défaut, loopback) doit répondre à une sonde TCP bash `/dev/tcp`, sans dépendance nouvelle.
- Grâce de 60 s depuis le démarrage du processus (âge `ps etimes`) ; une Gateway plus jeune, quel que soit son lanceur, suspend toute action. Il faut deux constats consécutifs (port fermé, grâce dépassée, même PID et même instant de démarrage `/proc/<pid>/stat`).
- Avant d'agir, le watchdog prend le bail de réparation existant (`runtime_mode.py --repair-lease`, verrou `deploys/companion-deploy.lock`), exactement comme le Companion avant `startRuntime` : déploiement, campagne QA, relance Companion en cours ou arrêt d'urgence Tier0 = rien (journal `gateway_recovery_deferred`, avec la raison).
- Sous le bail : nouvelle sonde, puis SIGTERM au PID précis, attente bornée (10 s), SIGKILL si besoin, relance par `gateway-start.sh` ; le processus relancé n'hérite pas du bail.
- Cause journalisée : `cause=gateway_alive_port_closed` ; journal borné à une génération précédente (256 Kio).

Limite vue sur le S24 : `core-services-watchdog.sh` n'y est lancé par aucun propriétaire actif (ni `~/.termux/boot`, ni Tier0, ni le gardien, ni le gestionnaire de santé) ; aucun processus vivant, dernier journal le 07/10. Ce correctif ne prend effet que si un propriétaire existant le lance.

Retour arrière : revert de ce commit puis redéploiement du core.
