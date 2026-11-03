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
1. **préflight** (`--wait-calm` comme `companion-deploy.sh`) : charge, mémoire, disque libre au moins égal à 3 fois les bases, aucun job lourd, verrou, versions (9.6 en place, 10.9 et Node 24.22.2 candidats). Prérequis :
   - jeux de compatibilité vérifiés sur le candidat ;
   - ligne 2026.10.9 du SDK dans le plugin Samantha déployé ;
   - garde anti-triage dans `gateway-start.sh` ;
   - `secrets.egressProxy` non configuré, ou correctif du module CA du proxy (`dist/ca-D3c9PAvv.mjs`) épinglé dans `android-fs-compat` (#511). Sinon le préflight refuse sur `egress_proxy` ; aucun `--skip-prerequisite egress_proxy` n'est nécessaire une fois #511 fusionnée.

   Un préflight à blanc de la prod (`--dry-run`, 18:23) refuse aujourd'hui sur `agent-exec-auth-scope`, `gateway-prep-stages`, `triage_guard` et `egress_proxy`. Il trouve la Gateway, les 20 bases (302 Mo) et la ligne SDK 2026.10.9 du plugin déployé. Un refus ne coupe rien.
2. **stage**, Gateway encore en service : copie du candidat OpenClaw et de Node à côté des arbres vivants. `@openclaw/whatsapp@2026.10.9` est installé par npm dans une copie de son projet.
3. **stop** : la Gateway est arrêtée par son PID, trouvé de trois façons, chacune vérifiée sur le dossier d'état :
   - le bail OpenClaw `state_leases/gateway-owner` ;
   - le titre `openclaw-gateway` ;
   - le processus lancé par le script.

   Android refuse `/proc/net` et netlink aux applications : impossible de passer par le port. Le Companion est arrêté lui aussi. Il charge le SDK OpenClaw en mémoire et ouvre les bases d'agent, d'où une sauvegarde cohérente. `core-services-watchdog.sh` est suspendu par SIGSTOP s'il tourne.
4. **backup** : chaque base SQLite (état, 7 bases d'agent, états headless) passe par l'API de sauvegarde SQLite, qui lit aussi le WAL, puis `PRAGMA integrity_check` sur chaque copie. Sont aussi sauvegardés `openclaw.json`, `credentials/` et les JSON d'agent.
5. **switch** : les arbres OpenClaw 9.6 et Node v24.21.0 sont renommés à côté, sur le même système de fichiers, et les candidats prennent leur place.
6. **whatsapp** : le projet npm 10.9 remplace le projet 9.6, qui est mis de côté. Doctor ne voit donc jamais un paquet 9.6 à « réparer ».
7. **doctor** : `openclaw doctor --fix --non-interactive` tourne Gateway arrêtée, avec `OPENCLAW_SHELL=exec`, et une seule relance s'il reste un bail.
8. **consent** : `plugins enable openclaw-plugin-mobile-ui --accept-capabilities`.
9. **start** et gates :
   - santé HTTP 200 ;
   - `health --json` avec le plugin Samantha chargé ;
   - `plugins inspect --runtime` : plugin chargé avec au moins 42 outils ;
   - un tour agent réel (`agent --agent main`, session dédiée, sans livraison, budget 300 s) ;
   - plugin WhatsApp chargé à la bonne version, et connecté en production ;
   - Companion prêt, en production ;
   - aucun processus de triage automatique.
10. **reçu** : `deployed`.

Sur échec après l'arrêt, le retour arrière est automatique, y compris sur SIGTERM ou SIGINT pendant la fenêtre :
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

Chaque passe repart d'une copie fraîche de la prod (sauvegarde en ligne, 20 bases, 297 Mo en 4 à 8 s). Les reçus se trouvent dans `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-01-openclaw-upgrade-1009/`. Toutes les durées sont en secondes.

| passe | issue | stage | backup + integrity | doctor | santé 10.9 | coupure (arrêt → santé) | retour arrière | coupure totale | santé 9.6 | tour 9.6 |
|---|---|---|---|---|---|---|---|---|---|---|
| 162000 | `rolled_back` (`plugins update` refusé sous Android) | 18,5 | 2,5 + 1,2 | 324,4 | — | — | 151,6 | 492 | 68,0 | 68,5 |
| 163827 | `rollback_failed`* (Worker egress, triage) | 44,2 | 1,7 + 0,4 | 514,2 | Gateway morte après 180 s | — | 215,6 | 914 | 94,3 | 70,5 |
| 172851 (b) | `rolled_back`, Node gardé en 24.22.2 | 30,1 | 1,3 + 0,7 | 95,9 (échec) | — | — | 200,7 | 299 | 71,3 | 78,4 |
| 174046 | `rolled_back` (inspection statique : 0 outil) | 12,3 | 1,6 + 0,4 | 457,9 | 60,4 | 547,8 | 245,4 | 1 036 | 72,3 | 83,5 |
| **175913 (a)** | **`deployed`** | 47,3 | 3,9 + 0,6 | 395,5 | 75,0 | **494,7** | — | — | — | — |

\* La 9.6 répondait (santé et tour) ; seule la gate WhatsApp de préproduction échouait. Les enregistrements de plugin de la copie visaient alors le projet WhatsApp de prod. Ces enregistrements sont réécrits depuis la passe 172851.

Passe nominale 175913 :
- WhatsApp npm hors fenêtre, en 19 s ;
- consentement de capacités, 18,7 s ;
- santé, 75 s après le démarrage ;
- `health --json` : plugin Samantha chargé, 13 plugins ;
- `plugins inspect --runtime` : 42 outils ;
- premier tour agent 10.9 à froid, 198,7 s ;
- plugin WhatsApp 2026.10.9 chargé ;
- aucun triage.

L'arrêt d'une Gateway 9.6 en service a pris 16,9 s (passe 162000). Dans les autres passes, la Gateway de préproduction était déjà arrêtée.

**Coupure attendue en prod** :

| étape | durée |
|---|---|
| arrêt de la Gateway et du Companion | environ 20 s |
| sauvegarde et integrity_check | environ 5 s |
| doctor | 6,5 à 8,5 min |
| consentement | environ 20 s |
| démarrage jusqu'à la santé | 60 à 75 s |
| **total** | **8 à 10 min**, plus la relance du Companion |

Après la santé, les gates prennent encore 4 à 5 min, service rétabli : le tour agent à froid prend environ 200 s, et s'y ajoutent la connexion WhatsApp et le Companion.

**Retour arrière mesuré** : 2,5 à 4 min, de l'échec à la fin des gates de la 9.6 :
- arrêt, 0 à 31 s ;
- restauration, 1,3 à 3,2 s ;
- santé 9.6, 68 à 136 s ;
- tour 9.6, 68 à 190 s.

Dans le pire cas mesuré, l'échec arrive à la toute dernière gate. La coupure totale atteint alors 15 à 17 min (passe 174046).

**Node** : la 9.6 redémarre et répond sous Node 24.22.2, sur des bases restaurées (passe 172851, `rollback_node: keep` : santé 71 s, tour 78 s). Par défaut, le retour arrière remet tout de même v24.21.0 : c'est un simple renommage, et c'est l'état d'origine exact.

**Intégrité après restauration** : dans les 4 retours arrière, chaque base restaurée a un SHA256 égal à sa sauvegarde, et `integrity_check` est OK sur les 20 bases (phase `rollback_integrity`, 1 à 3 s).


## Ce que la répétition a trouvé (bloquants pour la prod)

1. **Le Worker du proxy d'egress des secrets ne démarre pas en 2026.10.9.** `secrets.egressProxy` est configuré en prod, et la Gateway refuse de démarrer : « Secret egress proxy Worker is unavailable ». Le bundle de stabilité est `state/logs/stability/*gateway.startup_failed.json` (pile dans `runtime-BobAZq4r.mjs`, message `fatal` du Worker). Le même fs-safe 0.26 refuse tout espace temporaire sous `/data` (uid 1000), probablement la même cause. La configuration réduite de l'étape 3 n'avait pas ce bloc, d'où l'absence de problème alors. Sans correctif, la bascule de prod revient en arrière toute seule.
2. **Le triage automatique se déclenche bel et bien.** Quand le démarrage échoue, la 10.9 lance « Automatic triage » : environ 2 min, `openclaw triage`, qui échoue ici (`claude`/`codex` remplacés par des leurres en préprod). Le script le détecte (gate `no_triage`, journal et processus) et tue ces processus au retour arrière. La garde dans `gateway-start.sh` reste à décider. Tant qu'elle manque, le préflight de prod refuse (`triage_guard`).
3. **Le plugin Samantha se charge avec 0 outil sur 56 en 10.9.** Message : « requires capability consent ». Le script ajoute la phase `consent` (`plugins enable openclaw-plugin-mobile-ui --accept-capabilities`, hors ligne). Sans elle, la gate `plugin_tools` fait revenir en arrière.
4. **Le tour agent restait bloqué sur le hook `before_model_resolve` du plugin Samantha.** La copie de préproduction chargeait le plugin depuis le dossier de prod : les enregistrements d'installation sont dans `config_machine_state` de la base d'état, avec des chemins absolus. Le hook résolvait alors le SDK 9.6 de prod. En prod, la racine globale porte la 10.9 après la bascule. La préproduction réécrit maintenant ces enregistrements, refait les liens « peer » vers sa propre racine et pointe `CLAWMOBILE_OPENCLAW_BIN` sur elle. Depuis, le tour 10.9 répond (passes 174046 et 175913).
4 bis. `plugins inspect` sans `--runtime` liste 0 outil, en 9.6 comme en 10.9. La gate lit donc `--runtime`, qui en liste 42.
4 ter. Le lien « peer » OpenClaw du projet WhatsApp se trouve dans `node_modules/@openclaw/whatsapp/node_modules/openclaw`. npm le supprime quand il remplace le paquet, et le script le recrée.
5. **`openclaw plugins update` et `install` échouent sous Android en 2026.10.9** (fs-safe : `/data` appartient à l'uid 1000). WhatsApp est donc préparé avec npm, hors fenêtre, en 18 s.
6. **`doctor --fix` est la phase longue** : 324 à 514 s sur les copies en vraie taille. Il fait tourner des contrôles de « peer link » sur chaque plugin npm. Doctor migre :
   - les 7 bases d'agent, schéma v23 → v25 ;
   - la base d'état, v18 → v20 ;
   - la config (`systemAgent` et `heartbeat.agentId`).

   Les `headless-state*` restent en v18.
7. Une copie de base porte le bail de la Gateway de prod (PID vivant). Sur la copie, le démarrage est refusé. En prod, le bail de la Gateway arrêtée est mort.

## Tests

`installer/termux-lite/test-openclaw-upgrade.py` (24 tests, inscrit dans la CI) fait tourner le vrai script, hors S24. Un faux `openclaw` (CLI et Gateway, avec son bail d'owner) et un faux npm remplacent les vrais. Les bases, la config, les identifiants et le projet WhatsApp sont réels. Cas couverts :
- chemin nominal ;
- échec forcé d'une gate ;
- échec de doctor ;
- Gateway qui ne répond jamais ;
- échec du démarrage avec triage automatique, enregistré puis tué ;
- consentement absent : 0 outil, retour arrière ;
- SIGTERM pendant doctor : retour arrière ;
- retour arrière lui-même en échec, avec avis ;
- verrou pris ;
- job lourd ;
- charge trop haute après l'attente bornée ;
- disque insuffisant et prérequis absents ;
- candidat WhatsApp en échec, sans coupure ;
- sauvegarde de lignes encore dans le WAL ;
- inventaire et caviardage ;
- profils prod et préprod ;
- enveloppe `--detach` ;
- reçus réels de la répétition (fixture).

## Retour arrière de cette PR

Revenir sur le commit. Le script ne tourne que si on le lance. Après une bascule `deployed`, le reçu nomme les arbres `openclaw.rollback-2026.9.6-<stamp>` et `node.rollback-<stamp>`, ainsi que le jeu de sauvegarde, pour un retour manuel.

**NO_CAPABILITY** : aucune route, action ni capability. Le paiement n'est pas touché.

## Commande de bascule de production

Elle se lance une fois cette PR déployée par `companion-deploy.sh` et les bloquants levés. Préflight seul d'abord, puis la bascule détachée :

```
~/ClawMobile/installer/termux-lite/openclaw-upgrade.sh --profile prod --dry-run
~/ClawMobile/installer/termux-lite/openclaw-upgrade.sh --profile prod --wait-calm 900 --detach
~/ClawMobile/installer/termux-lite/openclaw-upgrade.sh --profile prod --status
```

La dernière commande lit le reçu `~/.openclaw/deploys/openclaw-upgrade-<stamp>.json`.
