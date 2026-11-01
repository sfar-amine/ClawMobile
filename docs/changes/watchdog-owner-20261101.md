# Watchdog des services cœur : un propriétaire existant, la Gateway seulement — 1er novembre 2026

Constat (S24, lecture seule, 01/11) :
- `core-services-watchdog.sh`, durci par #506, n'a aucun propriétaire : aucun processus, dernier journal le 07/10, rien dans Termux:Boot, Tier0, le gardien ni le gestionnaire de santé.
- Une Gateway vivante mais muette pendant que le Companion est arrêté n'était donc relancée par personne.

Qui supervise quoi (S24, 18:20) :
- Termux:Boot → `tier0-bootstrap.sh` → `samantha-root-guardian.sh` (PID 3690), qui tient `tier0-watchdog.py` (4143), `samantha-health-manager.sh` (4869) et `incident-orchestrator-worker.sh` (5290).
- Le gestionnaire de santé tient les superviseurs `adb-recovery-watchdog.sh` (8294), `remote-desktop-watchdog.sh` (8709), `incident-manager.sh` (9158), et répare le Companion par `check_http` (bail, budget, preuve d'inactivité).
- Le Companion (28504/28884) tient la Gateway (32163) : sonde toutes les 15 s, puis `startRuntime` sous le même bail.
- Le gestionnaire de santé constate seulement l'état de la Gateway (`owner=companion`).

Lancé tel quel, le watchdog aurait doublé deux supervisions :
- `heal cp` relance le Companion hors bail, contre `check_http` ;
- `heal gw` lance `gateway-start.sh` sans bail, en même temps que le watchdog du Companion, qui ne voit pas `openclaw-gateway` pendant la préparation.

Correctif :
- Le gestionnaire de santé lance `core-services-watchdog.sh --gateway-only` par son `check_supervisor` existant, comme les watchdogs adb et remote-desktop. L'option fait partie de l'identité : une instance sans option est remplacée. Le verrou singleton est attendu avant remplacement. Le motif est ancré (`/[c]ore-services-watchdog[.]sh( |$)`) : un `test-core-services-watchdog.sh` en cours (CI, diagnostic localci-s24) n'est ni compté comme superviseur ni arrêté.
- `--gateway-only` : le Companion n'est jamais lancé. Tant qu'un processus Companion vit, la Gateway reste au watchdog du Companion et rien n'est fait. Sans Companion :
  - Gateway muette : le chemin de #506 s'applique (grâce de 60 s, deux constats), avec un nouveau contrôle du Companion sous le bail ;
  - Gateway absente : un seul lancement sous le bail.
- La passerelle IA passe par le Companion. Sans processus Companion, elle ne peut pas répondre : le lancement borné du watchdog est alors direct (budget de relances), même règle que la réparation du Companion.
- Le verrou singleton est désormais tenu pendant toute la boucle. Chaque enfant durable le ferme, et le bail aussi. La Gateway relancée est détachée : elle n'est pas descendante du watchdog (`--restart-core` de Tier0 arrête l'arbre du gestionnaire).

Retour arrière : revert de ce commit puis redéploiement du core par `companion-deploy.sh`.
