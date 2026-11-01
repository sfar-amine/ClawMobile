# OpenClaw 2026.9.6 → 2026.10.9 : script de bascule avec retour arrière automatique — 1er novembre 2026

Étape de bascule de la montée OpenClaw (les étapes 1 à 3 ont préparé le SDK, les jeux de compatibilité et la préproduction). Un seul script fait la bascule de production et sa répétition en préproduction : `installer/termux-lite/openclaw-upgrade.sh` (propriétaire `openclaw-upgrade.py`).

## Pourquoi un script à part, et pas une étape de `companion-deploy.sh`

`companion-deploy.sh` déploie un commit du checkout : il fait une avance rapide, construit le plugin, relance le Companion et le juge. La montée OpenClaw ne change aucun commit. Elle remplace l'installation globale et Node, migre les bases et la config (`doctor --fix`), et son retour arrière restaure des données. Ce n'est pas un retour arrière de code.

Le script ne crée pas pour autant un second système de déploiement. Il reprend les propriétaires existants de `companion-deploy.sh` :
- le même verrou `deploys/companion-deploy.lock`. Tant qu'il est tenu, le gestionnaire de santé ne répare rien et le Companion refuse `/v1/runtime/restart`, donc rien ne relance la Gateway pendant la fenêtre ;
- le même dossier de reçus `~/.openclaw/deploys/`, avec un reçu `openclaw-upgrade-<stamp>.json` ;
- les mêmes seuils de préflight : charge 7, 1 200 Mo disponibles, aucun job lourd ;
- le même lancement de la Gateway (`gateway-start.sh` de la release, avec ses jeux de compatibilité) et du Companion (`companion-server.sh`) ;
- le même avis `incident-notify.sh human_required` si le retour arrière n'est pas sain ;
- la levée des baux d'agent par `gateway-preflight.py agent-leases`.

## Ce que fait le script

Les phases, chronométrées dans le reçu :
1. **préflight** : charge, mémoire, disque libre au moins égal à 3 fois les bases, aucun job lourd, verrou, versions (9.6 en place, 10.9 et Node 24.22.2 candidats). Prérequis : jeux de compatibilité vérifiés sur le candidat, ligne 2026.10.9 du SDK dans le plugin Samantha déployé, garde anti-triage dans `gateway-start.sh`. Un refus ne coupe rien.
2. **stage**, Gateway encore en service : copie du candidat OpenClaw et de Node à côté des arbres vivants. `@openclaw/whatsapp@2026.10.9` est installé par npm dans une copie de son projet.
3. **stop** : la Gateway est arrêtée par son PID, trouvé de trois façons, chacune vérifiée sur le dossier d'état :
   - le bail OpenClaw `state_leases/gateway-owner` ;
   - le titre `openclaw-gateway` ;
   - le processus lancé par le script.

   Android refuse `/proc/net` et netlink aux applications : impossible de passer par le port. Le Companion est arrêté lui aussi. Il charge le SDK OpenClaw en mémoire et ouvre les bases d'agent, d'où une sauvegarde cohérente. `core-services-watchdog.sh` est suspendu par SIGSTOP s'il tourne.
4. **backup** : chaque base SQLite (état, 7 bases d'agent, états headless) passe par l'API de sauvegarde SQLite, qui lit aussi le WAL, puis `PRAGMA integrity_check` sur chaque copie. Sont aussi sauvegardés `openclaw.json`, `credentials/` et les JSON d'agent.
5. **switch** : les arbres OpenClaw 9.6 et Node v24.21.0 sont renommés à côté, sur le même système de fichiers, et les candidats prennent leur place.
6. **doctor** : `openclaw doctor --fix --non-interactive` tourne Gateway arrêtée, avec `OPENCLAW_SHELL=exec`, et une seule relance s'il reste un bail.
7. **whatsapp** : le projet npm 10.9 remplace le projet 9.6, mis de côté.
8. **start** et gates :
   - santé HTTP 200 ;
   - `health --json` avec le plugin Samantha chargé ;
   - `plugins inspect` : plugin chargé avec au moins 42 outils ;
   - un tour agent réel (`agent --agent main`, session dédiée, sans livraison) ;
   - plugin WhatsApp chargé à la bonne version, et connecté en production ;
   - Companion prêt, en production ;
   - aucun processus de triage automatique.
9. **reçu** : `deployed`.

Sur échec après l'arrêt, le retour arrière est automatique :
- arrêt, et arrêt des triages éventuels ;
- arbres 9.6 et Node remis en place ;
- bases restaurées (copie atomique, WAL et SHM retirés, SHA256 égal à la sauvegarde) ;
- config, `credentials/` et projet WhatsApp 9.6 remis en place ;
- relance du Companion et de la Gateway ;
- santé, tour agent, WhatsApp et `integrity_check` des bases restaurées ;
- reçu `rolled_back`, ou `rollback_failed` avec un avis.

Ni le reçu ni le journal ne contiennent de secret. Le reçu ne garde ni contenu de config ni valeur d'environnement ni sortie brute (la sortie santé contient des numéros). Il garde des booléens, des comptes, des versions, des tailles et des durées. Les journaux CLI sont caviardés. Pas de `rm -rf` large : seuls les jeux de sauvegarde et les arbres de retour arrière de ce propriétaire sont élagués, à leur nom exact (les deux plus récents sont gardés). Rien n'est écrit dans `/tmp`.

## Répétition en préproduction (S24, 1er novembre)

Racine `~/.openclaw-android/staging/upgrade-rehearsal`, port 19789, prod intacte. Les copies fraîches en vraie taille des bases de prod sont faites par sauvegarde en ligne, sans arrêter la prod (20 bases, 297 Mo, 1,2 s) :
- `openclaw.json` est réécrit vers la racine de préproduction ;
- `credentials/` n'est pas copié et les canaux sont coupés (`OPENCLAW_SKIP_CHANNELS=1`). Le vrai compte WhatsApp ne se connecte jamais deux fois ;
- `OPENCLAW_SKIP_CRON=1` : les tâches planifiées de prod ne tournent pas sur la copie ;
- les baux copiés, qui nomment le PID de la Gateway de prod, sont vidés.

MESURES

## Ce que la répétition a trouvé

- `openclaw plugins update` (et `install`) échoue sous Android en 2026.10.9. fs-safe refuse tout espace temporaire sous `/data`, qui appartient à l'uid 1000. Le script prépare donc WhatsApp avec npm, hors fenêtre. Le correctif amont reste à faire dans le jeu `android-fs-compat`.
- La copie de base qui servait au premier essai de Gateway 9.6 portait le bail de la Gateway de prod (PID vivant), et le démarrage a été refusé. En prod, le bail de la Gateway arrêtée est mort, donc libre.
- `doctor --fix` est la phase longue de la coupure.
- Doctor migre :
  - les 7 bases d'agent, schéma v23 → v25 ;
  - la base d'état, v18 → v20 ;
  - la config (`systemAgent` et `heartbeat.agentId`) ;
  - les index d'état partagé.

  Les bases `headless-state*` restent en v18.

## Tests

`installer/termux-lite/test-openclaw-upgrade.py` (inscrit dans la CI) fait tourner le vrai script, hors S24. Un faux `openclaw` (CLI et Gateway, avec son bail d'owner) et un faux npm remplacent les vrais. Les bases, la config, les identifiants et le projet WhatsApp sont réels. Cas couverts :
- chemin nominal ;
- échec forcé d'une gate ;
- échec de doctor ;
- Gateway qui ne répond jamais ;
- retour arrière lui-même en échec, avec avis ;
- verrou pris ;
- job lourd ;
- disque insuffisant et prérequis absents ;
- candidat WhatsApp en échec, sans coupure ;
- sauvegarde de lignes encore dans le WAL ;
- inventaire et caviardage ;
- profils prod et préprod ;
- reçus réels de la répétition (fixture).

## Retour arrière de cette PR

Revenir sur le commit. Le script ne tourne que si on le lance. Après une bascule `deployed`, le reçu nomme les arbres `openclaw.rollback-2026.9.6-<stamp>` et `node.rollback-<stamp>`, ainsi que le jeu de sauvegarde, pour un retour manuel.

**NO_CAPABILITY** : aucune route, action ni capability. Le paiement n'est pas touché.
