# G3 — intégrer, activer et vérifier le runtime natif

Ce runbook est une livraison documentaire sur la base Companion `2c2c18fff0631d1545035c0cedacf42e7d8f4065`. Les commandes d'activation ci-dessous sont destinées à Claude sur le S24 après relecture et fusion. Codex ne les exécute pas, ne fusionne pas les PR et ne déclare aucune activation ou recette physique. Une PR ouverte fournit une interface en revue ; elle ne prouve ni sa présence dans le build actif ni sa qualification.

## Inventaire des interfaces

Les chemins sont complets. Les objets, corps, confirmations et états viennent du contrat du lot concerné. Les identifiants de recette sont des fixtures dédiées choisies par Claude ; aucune donnée bancaire ne doit servir de canary.

| Lot | Lecture / interface | Mutation native | Livraison / qualification |
| --- | --- | --- | --- |
| R1/R2/R3 | GET `/v1/runs`, `/v1/runs/{runId}`, `/v1/runs/by-client/{clientRunId}` ; GET `/v1/sessions/{sessionId}/turns?contract=2` | DELETE `/v1/runs/{runId}` (suppression, distincte de l’arrêt d’une exécution) | Contrats fusionnés ; runs financiers/confirmations protégés |
| R5 / P2-a | GET `/v1/control/automations?contract=2`, `/v1/automations/{id}` | POST `/v1/automations/{id}/enable`, `/disable`, `/run` ; DELETE `/v1/automations/{id}` | P2-a fusionné ; [R5 #31](https://github.com/sfar-amine/samantha-core/pull/31) fusionné b4c6704, objectif de latence à mesurer |
| P2-c / R10 | GET `/v1/control/requests/{REQ-n}?contract=2` | POST `/v1/control/requests/{REQ-n}/cancel` | P2-c fusionné ; [R10 #32](https://github.com/sfar-amine/samantha-core/pull/32) et [playbooks #16](https://github.com/sfar-amine/samantha-ui-playbooks/pull/16) en revue : session d'origine explicite, null pour anciennes demandes |
| P2-e | GET `/v1/control/diagnostic?contract=2`, `/v1/control/diagnostic/logs/{agent|installation|engineering}`, `/v1/control/diagnostic/export` | Aucune : export **GET**, sans opération durable | Fusionné ; métadonnées filtrées, export sans contenu brut ni secret |
| P2-b | GET `/v1/skills/{id}` | POST `/v1/skills/{id}/enable`, `/disable`, `/try` | [#24](https://github.com/sfar-amine/samantha-core/pull/24) en revue ; essai accepté ne signifie pas tâche terminée |
| P2-d | GET `/v1/control/memory?q=&kind=&offset=0&limit=20` | POST `/v1/control/memory/{eventId}/forget`, `/v1/control/memory/import/preview`, `/v1/control/memory/import` | [Core #26](https://github.com/sfar-amine/samantha-core/pull/26), [playbooks #15](https://github.com/sfar-amine/samantha-ui-playbooks/pull/15) fusionnés 4e018ab / 19bf110 ; aperçu sans écriture, sélection explicite avant import |
| P2-f | GET `/v1/laptop-access/computers`, `/v1/laptop-access/pairings/{id}` | POST `/v1/laptop-access/pairings`, `/v1/laptop-access/pairings/{id}/commit` ; DELETE `/v1/laptop-access/computers/{id}` | Fusionné ; biométrie avant autorisation/révocation, dernière clé protégée |
| R6 | GET `/v1/agent/config` | POST `/v1/agent/config` avec révision opaque du GET et confirmation lorsque requise | Fusionné, y compris hash opaque #33 ; outils restent en lecture, capacités d'écriture indiquées dans la projection |
| R7 | GET `/v1/updates` | Aucune : les méthodes de mutation sont refusées | Fusionné #22 ; versions et releases préparées vérifiées, aucune route `/updates/update` ou `/updates/rollback` |
| R8 | GET `/v1/skills/candidates?limit=50`, `/v1/skills/candidates/{traceId}` | POST `/v1/skills/learn` (en-tête propriétaire) | [#47](https://github.com/sfar-amine/samantha-core/pull/47) fusionné 2c2c18f ; brouillons candidats, aucune promotion ; volume réel d'enregistrements nul sur le S24 |
| R9 | GET `/v1/notifications/sources`, `/v1/control/notifications?contract=2` | Uniquement les routes enable/disable P2-a pour les items scheduled avec automationId | Fusionné ; incidents/situations non désactivables, états inconnus explicites, pas de route de mutation R9 ; sans P2-a actif, aucun interrupteur |
| R11 | GET `/v1/conversations/{sessionId}/metadata` | POST sur le même chemin : titre, épinglage ou modèle fermé | [#28](https://github.com/sfar-amine/samantha-core/pull/28) en revue ; modèle refusé pendant un run actif, aucun nouveau registre |
| R12 | GET `/v1/control/engineering` | Aucune | Fusionné #23 ; continuations du propriétaire existant, aucune réconciliation déclenchée par lecture |
| R13 | GET `/v1/capabilities/{id}` | Aucune | [Core #41](https://github.com/sfar-amine/samantha-core/pull/41), [playbooks #19](https://github.com/sfar-amine/samantha-ui-playbooks/pull/19) fusionnés 7118457 / 2ba0e72 : fiche registry, pas d'exécution ni promotion |
| R14 | GET `/v1/attachments/{id}/content` | POST `/v1/attachments` binaire, `/v1/attachments/share` | [#14](https://github.com/sfar-amine/samantha-core/pull/14) fusionné 0bf30ab ; id obligatoire, idempotence par contenu, limites/rétention de son contrat, aucune réservation de run à l'upload |
| R15 | GET `/v1/security/surfaces` | Aucune | [#30](https://github.com/sfar-amine/samantha-core/pull/30) fusionné 198e78d ; clients/transports observés, aucune révocation inventée |
| R16 | GET `/v1/runs/{runId}/approval` | POST sur le même chemin, seulement allow-once ou deny avec confirmation liée | [#36](https://github.com/sfar-amine/samantha-core/pull/36) fusionné aa09bad ; pending réel à qualifier, paiement exclu, aucune décision à partir d'un cache périmé |
| R17 | GET `/v1/whatsapp/allowlist`, `/{contactId}`, `/history`, `/{contactId}/note` | POST liste, PATCH/DELETE contact, PUT note sous `/v1/whatsapp/allowlist` | [Core #39](https://github.com/sfar-amine/samantha-core/pull/39), [playbooks #17](https://github.com/sfar-amine/samantha-ui-playbooks/pull/17) ; claim avant consommation biométrique, owner protégé, sweep dans le cycle santé existant |
| V5 | GET `/v1/voice/voices` | Choix `voice` lors de l'ouverture via POST `/v1/extensions/claw-live/token` ou `/prewarm`, socket existante | [#34](https://github.com/sfar-amine/samantha-core/pull/34) fusionné 61a1994 ; préférences Android, aucun PUT `/v1/voice/voice` ni stockage Companion, candidats fournisseur à qualifier |

L'inventaire décrit les lots connus lors de cette rédaction. Relire la version finale de chaque PR avant activation : un chemin 404 dans une ancienne version est un endpoint absent, pas un résultat de recette réussi. R8 est fusionné ([#47](https://github.com/sfar-amine/samantha-core/pull/47), `2c2c18f`) : POST `/v1/skills/learn` (en-tête propriétaire), GET `/v1/skills/candidates?limit=50` et `/v1/skills/candidates/{traceId}`, sans promotion automatique ; les suites de la revue 26 sont fusionnées (#49, `af80166`). C2 est une clôture de continuations par Claude ; C4 ajoute uniquement des tests JVM (#45), sans écart runtime. A5 est clos selon Claude. Ce runbook ne déclare pas la recette des lots ouverts.

## Outils runtime : journal live, shell, redémarrage

Interfaces natives existantes (PR #12), présentes dans `server.ts` de la base. Elles sont **loopback uniquement** (`isLocalOnlyRoute` : toute route sauf `/`, `/health` et `/capabilities` est refusée hors 127.0.0.1) et réservées au client natif ; ce ne sont ni des outils agent ni un routeur métier.

| Outil | Route | Effet |
| --- | --- | --- |
| Journal live | GET `/v1/runtime/log?maxBytes=65536` | Lecture de la fin du journal runtime (64 Kio par défaut). Peut contenir des données privées : lire localement, ne partager qu'une preuve nettoyée. |
| Shell | GET `/v1/terminal/session`, POST `/v1/terminal/session/input` `{text}`, POST `/v1/terminal/session/reset`, POST `/v1/terminal/command` `{command}` | Shell Termux réel. Aucune commande bancaire, aucune lecture de secret (`.env`, jetons), aucun `env` affiché. |
| Redémarrage | POST `/v1/runtime/restart` (aussi `/runtime/stop`, `/runtime/start`) | Arrête puis relance la **Gateway OpenClaw** (`restartRuntime`, opérations sérialisées). Ne redémarre pas le Companion et ne déploie rien. |

**Le redémarrage canonique est POST `/v1/runtime/restart`, et seulement sans run actif.** La route ne vérifie pas elle-même les runs : Claude le fait avant, auprès du propriétaire des runs, et renonce si un run, un paiement ou une confirmation humaine est en cours.

```sh
# 0 run actif attendu ; sinon attendre la fin ou l'arrêt explicite du run, jamais de redémarrage par-dessus.
curl -fsS -m 10 'http://127.0.0.1:8765/v1/runs?summary=1&limit=100' \
  | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runs"] if x.get("state")=="running"]; print(len(r)); sys.exit(1 if r else 0)' \
  && curl -fsS -m 60 -X POST http://127.0.0.1:8765/v1/runtime/restart
curl -fsS -m 5 http://127.0.0.1:8765/v1/health
```

Un redémarrage n'est pas un déploiement et ne remplace pas `companion-deploy.sh` (qui, lui, relance le Companion). Pour le Companion lui-même, seul le déploiement sûr ci-dessous fait foi.

## Vue propriétaire claw-live

La vue Contrôle publique est GET `/v1/control/activity/stream` (SSE, `--control-json`) : sans contenu privé. La vue propriétaire est le même flux avec `?view=owner` : `control.ts` lance `claw-live.py --owner-json --history 60`, qui restitue d'abord les 60 dernières lignes du transcript (timestamps réels, `replay:true`), puis les événements live avec tags, action et aperçus nettoyés.

- Locale (loopback) et limitée à **deux flux actifs** ; un troisième reçoit 429 `control_stream_busy`.
- Fermer la vue termine le groupe de processus du lecteur (SIGTERM, puis SIGKILL après 2,5 s). Aucun store ni démon ajouté.
- Recette Claude : ouverture non vide (lignes `replay:true`), reconnexion sans doublon, flux public toujours sans aperçu. Ne pas publier de transcript ; ce journal n'est pas une recette de la voix duplex.

```sh
curl -sN -m 15 'http://127.0.0.1:8765/v1/control/activity/stream?view=owner' | head -c 2000 >/dev/null && echo owner_view_ok
```

## Récupération ADB native après reboot

Android coupe le débogage sans fil à chaque reboot ; le chemin ADB canonique `127.0.0.1:5556` restait donc indisponible jusqu'à une bascule manuelle (reboot contrôlé du 10/10 : adb-recovery épuisé, incident 2c94db3e). Le correctif `f64513fb9e0830759b84768eb920c228f4faa8cb` (« re-arm wireless debugging natively after reboot ») est sur la **branche app** `feature/samantha-ux-c11-20261009`, pas sur la base runtime : il n'agit qu'une fois l'app construite depuis cette branche et installée par `install-from-ci.sh`.

- Le `RecoverySignalReceiver` existant (`NativeAdbRecovery`, `NativeRecoverySentinel.kt`) écrit uniquement `Settings.Global["adb_wifi_enabled"]=1`, relit la valeur, puis déclenche la réparation Tier0 existante.
- Déclencheurs existants : boot, remplacement du paquet, retour du Wi-Fi avec Internet, filet de sécurité de 15 minutes. Aucun nouveau scheduler ni shell arbitraire.
- Condition : la permission `WRITE_SECURE_SETTINGS` accordée une fois par ADB. `install-from-ci.sh` la réaccorde après chaque installation (`pm grant ai.samantha.android.dev android.permission.WRITE_SECURE_SETTINGS`). Sans ce grant, ne pas annoncer de réarmement.
- Le watchdog Termux (`adb-recovery-watchdog.sh`, `adb-recovery-supervisor.sh`, `adb-discover-endpoint.py`) reste propriétaire de la découverte d'endpoint, du serial S24 et du transport `127.0.0.1:5556`.

Vérification Claude, dans l'ordre :

```sh
adb -s 127.0.0.1:5556 shell dumpsys package ai.samantha.android.dev | grep -c 'WRITE_SECURE_SETTINGS: granted=true'
adb -s 127.0.0.1:5556 shell settings get global adb_wifi_enabled     # 1 attendu
python3 ~/ClawMobile/installer/termux-lite/adb-recovery-readiness.py --json --no-write  # transport et serial vus par le watchdog, sans écriture
```

Puis un passage Wireless Debugging OFF→ON sous signal natif. Un reboot physique contrôlé reste une preuve distincte, faite avec Amine ; ni le SHA ni les tests JVM ne l'attestent. Le script de réparation n'est jamais remplacé par une commande d'effet parallèle.

## Réviser et préparer l'activation

1. Claude relève le SHA Companion relu, les SHA playbooks appariés et la version Android concernée. Il intègre par PR les bases actuelles ; aucune reprise d'un ancien bundle avec ses ancêtres non relus. Toutes les étapes CI existantes, notamment M1, restent présentes.
2. Codex fournit les preuves Git : build/tests ciblés, CI locale appropriée et notes de livraison `not_applied`. Chaque nouveau test doit être inscrit dans ci.yml dans la même PR. Toute nouvelle route ajoute à companion-acceptance.py une lecture avec budget ou une mutation refusée sans en-tête propriétaire (règle 24). Les fixtures réelles et mesures S24 manquantes restent explicites.
3. Claude fusionne d'abord la partie playbooks d'un lot apparié, épingle son snapshot runtime, puis fusionne et déploie le Companion. Une copie modifiable de workspace ne remplace pas le pin. Les overrides explicites du propriétaire passent avant `current` ; en vérifier l'intention sans afficher l'environnement.
4. Avant restart/rollback, Claude vérifie l'absence d'étape bancaire ou de confirmation humaine active par leurs propriétaires existants. Aucun changement de paiement, de biométrie bancaire, d'OTP ni de reçu pour faciliter l'activation.

## Snapshot playbooks : commandes Claude

Le [propriétaire existant](../../../../installer/termux-lite/activate-ui-playbooks.sh) crée un worktree détaché au commit fourni, rejoue les contrats capability-decision/composed-reads, puis bascule atomiquement `~/.openclaw/runtime-ui-playbooks/current` et garde `previous`. Les helpers sont lancés par requête ; le pin n'exige pas un nouveau service. Renseigner le SHA relu, jamais un dossier arbitraire :

```sh
PLAYBOOKS_SHA='REMPLACER_PAR_LE_SHA_RELU_40_HEX'
~/ClawMobile/installer/termux-lite/activate-ui-playbooks.sh "$PLAYBOOKS_SHA"
```

Retour au snapshot précédent, seulement par Claude si la recette impose ce retour :

```sh
~/ClawMobile/installer/termux-lite/activate-ui-playbooks.sh --rollback
```

`ACTIVATED`, `ALREADY_ACTIVE` ou `ROLLED_BACK` atteste ce basculement ; il faut ensuite vérifier les sections Contrôle pertinentes et le comportement réellement observé. Ne pas supprimer les snapshots pendant la qualification.

## Companion : déploiement et retour arrière réel

`installer/termux-lite/companion-deploy.sh` et `companion-acceptance.py` viennent de #35 (fusionnée, `f1e1800`) ; le correctif du verrou #46 est fusionné (`a841936`) : le Companion relancé ne garde plus le descripteur du verrou. Tous deux sont dans la base `2c2c18f`. **C'est le seul chemin de déploiement du Companion.**

Ce que fait le script, dans l'ordre (vérifié dans le script de la base) :
1. **Verrou** `~/.openclaw/deploys/companion-deploy.lock` (`flock -n`) : un second déploiement sort en code 3 `deploy_already_running`.
2. **Préflight** : refus (reçu `refused`, code 4) si un job lourd tourne (`GradleDaemon`, `gradle-termux`, `tsc -p tsconfig`), si `MemAvailable` < 1 200 Mo (`COMPANION_DEPLOY_MIN_MB`) ou si la charge 1 min > 7 (`COMPANION_DEPLOY_MAX_LOAD`).
3. `git fetch samantha-private runtime/samantha-companion-private` ; la cible doit être un commit de cette branche (`commit_not_on_branch` sinon), le checkout propre (`dirty_checkout`) et l'avance **rapide uniquement** (`not_fast_forward`).
4. Sauvegarde du `dist` dans `~/.openclaw/backups/companion-<sha7>-<horodatage>` (5 gardées, `COMPANION_DEPLOY_KEEP`).
5. `npm run build` (nice 10), redémarrage du Companion, attente de `/v1/health` (2 min).
6. **Recette automatique** `companion-acceptance.py` : chaque lecture dans son budget ; chaque mutation refusée sans en-tête propriétaire ; `settle()` : une réponse `deferred` doit livrer ses données sous 15 s ; `LEAK` limité aux secrets (Bearer, `sk-`, `ghp_`…, `github_pat_`, AKIA, `refresh_token`/`access_token`, clés privées), un numéro ou un texte du propriétaire ne déclenche pas de retour arrière. Une route absente (404) est `skipped`. Depuis R8, la recette lit aussi le détail du premier candidat existant (jamais une trace fabriquée) et borne le refus de `POST /skills/learn` à 2 s.
7. **Retour arrière automatique** en cas d'échec de build, de santé ou de recette : `git reset --hard <précédent>`, restauration du `dist` sauvegardé, redémarrage et nouvelle recette. Reçu `rolled_back` si sain, sinon `rollback_failed` et incident `human_required` (`incident-notify.sh`).
8. **Reçu** `~/.openclaw/deploys/companion-<horodatage>.json` (`state` : `deployed`, `refused`, `failed`, `rolled_back`, `rollback_failed` ; `target`, `previous`, `detail`, `acceptance`) et journal `companion-<horodatage>.log` ; événement `context-event.sh work completed_action` après succès.

Commandes, réservées à Claude après vérification du SHA. Le redémarrage coupe le lien Claw : lancer détaché, puis lire le reçu.

```sh
COMPANION_SHA='REMPLACER_PAR_LE_SHA_COMPANION_RELU_40_HEX'
nohup ~/ClawMobile/installer/termux-lite/companion-deploy.sh "$COMPANION_SHA" >/dev/null 2>&1 </dev/null &
~/ClawMobile/installer/termux-lite/companion-deploy.sh --status    # dernier reçu
python3 ~/ClawMobile/installer/termux-lite/companion-acceptance.py  # recette seule, lecture uniquement
```

`--status` est la seule option de consultation ; il n'existe pas de `companion-deploy.sh --rollback`. Ne pas relancer un déploiement pour contourner un résultat incertain. Toute route à plus de 80 % de son budget dans un reçu devient une tâche d'optimisation.

Le [contrôleur Tier0](../../../../installer/termux-lite/tier0-control.py) porte séparément les releases des helpers Termux : `package`, `promote`, `rollback --reason`, `stop`, `resume`, `status`, `root`. Son rollback change le pointeur LKG **sans redémarrage automatique** ; `tier0-bootstrap.sh --restart-core` relance les superviseurs quand Claude le décide. Ce pointeur ne restaure pas le `dist` du Companion : ne jamais annoncer un rollback Companion sur la seule foi d'un pointeur Tier0.

La mémoire SQLite, les fichiers privés, les confirmations et les reçus restent dans leurs propriétaires : aucun reset ni suppression dans la procédure. Un retour manuel hors déploiement échoué part de la sauvegarde et du SHA précédents vérifiés, sans détourner une route R7 absente ni toucher au paiement.

## Installation de l’app depuis la CI

L'APK est compilé par GitHub Actions (workflow « Samantha Android app ») ; **pas de Gradle sur le téléphone**. Le seul installateur est `android/samantha/tools/install-from-ci.sh`, sur la branche app `feature/samantha-ux-c11-20261009` (introduit par `62762cf`), lancé depuis un checkout de cette branche sur le S24 :

```sh
APP_SHA='REMPLACER_PAR_LE_SHA_APP_RELU'
android/samantha/tools/install-from-ci.sh "$APP_SHA"
```

Le script, dans l'ordre : exige `gh` authentifié ; attend (40 min au plus) le run CI de ce commit exact, refuse un run non `success` ; télécharge l'artefact `samantha-app-optimized-<sha>` ; vérifie le **checksum** `app-optimized.apk.sha256` et que le **signataire** (`app-optimized.cert`) est la clé de debug du S24 (`~/.android/debug.keystore`) — sinon reçu `refused` (`checksum_mismatch`, `signer_is_not_this_phone_debug_key`) ; installe en place (`adb -s 127.0.0.1:5556 install -r`, données conservées) ; réaccorde `WRITE_SECURE_SETTINGS` (récupération ADB) ; écrit le reçu `~/.openclaw/deploys/app-<horodatage>.json` (`installed`, version et run). Un seul job lourd à la fois : pas d'installation pendant un déploiement Companion. Les tests JVM verts ne prouvent ni une recette UI ni une récupération après reboot.

## Reconnexion Claw après restart

Le Companion peut couper le lien qui a lancé le déploiement. Après reconnexion, lire le reçu du déploiement engagé et sa santé ; une reconnexion n'est pas une preuve de réussite du build.

Depuis le dépôt playbooks, commande de lecture prévue pour Claude ou un diagnostic Codex explicitement autorisé :

```sh
python3 tools/claw_mcp_client.py call claw_context --args '{"query":"verifier le contexte et le snapshot runtime apres integration Companion, lecture seule"}'
```

Lire réellement tous les `required_reads` et vérifier la fraîcheur et la readiness. `readiness: blocked`, notamment une couverture globale insuffisante, empêche de présenter le contexte comme prêt ; ne pas fabriquer une attestation ni lancer un effet pour masquer ce blocage. Ne jamais afficher l'environnement, `CLAW_MCP_TOKEN`, un token fournisseur ou une réponse privée brute. Le loopback d'une tâche Codex Cloud n'est pas le S24.

Pour une opération déjà engagée et devenue incertaine, `claw_status` conserve exactement les mêmes action_key/step_key. Vérifier l'effet avant toute autre décision ; aucun rejeu sous une clé neuve. Si le transport reste indisponible, Claude utilise le diagnostic du propriétaire existant. Pas de second relais, daemon, route métier parallèle ou repli financier.

## Recette et clôture

G2 est fusionné (#43, d7ae8f1) : `openclaw-plugin-mobile-ui/scripts/runtime-contract-report.py`, son inventaire `runtime-contract-cases.json` et `docs/work/samantha-runtime/contracts/g2.md` sont les chemins convenus avec son propriétaire. Ces fichiers sont présents dans la base `2c2c18f` ; leur présence ne prouve pas une couverture complète sur le S24. Le rapport exerce uniquement les GET, sans envoyer de mutation. Les mutations non financières exigent leurs preuves offline obligatoires ; le paiement est exclu. Des états pending/unknown, une interface absente ou une preuve manquante empêchent la couverture complète. Aucun rejeu d'un effet pour fabriquer la preuve d'idempotence.

Fournir des identifiants dédiés pour les détails et distinguer absents, non exercés et réussis. Un 404 ignoré par l'ancien contrôle de déploiement ne remplace pas la couverture requise de G2. Ne pas exporter une réponse brute, un numéro, un nom de contact, une note ou une conversation. Le [plan G4 #42](https://github.com/sfar-amine/samantha-core/pull/42) réserve le ménage runtime à Claude après les qualifications ; aucune suppression S24 n'est effectuée par G3 ou G4 Git.

[V2 #37](https://github.com/sfar-amine/samantha-core/pull/37) (fusionnée) teste la télémétrie historique ; [V4 #38](https://github.com/sfar-amine/samantha-core/pull/38) (fusionnée) produit un rapport p50/p95 avec appariement sid/source et exclusion de dérive >1 ms. Les journaux du 10 octobre sont des preuves historiques, pas une nouvelle recette. [V3 #40](https://github.com/sfar-amine/samantha-core/pull/40) (fusionnée) fournit une requalification duplex sans écrire la route ; Claude la fait avant RDV1. V5 exige qualification de chaque candidat fournisseur et écoutes/mesures appropriées ; un setup de fixture ne qualifie pas la voix réelle.

G1 conserve les recettes déjà déclarées par Claude. G2/G3/G4 sont des livraisons Git ; activation, écrans, nettoyage S24, RDV1/M1 et décision finale restent avec Claude et Amine. La clôture globale exige les preuves de chaque lot et ses dépendances, sans déclarer G5 ni M1 validés faute de contrat/preuve.
