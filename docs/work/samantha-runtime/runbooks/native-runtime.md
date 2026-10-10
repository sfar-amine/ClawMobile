# G3 — intégrer, activer et vérifier le runtime natif

Ce runbook est une livraison documentaire sur la base Companion `0bf30ab8370597e72f1afdd0fc2025603d4dc5f0`. Les commandes d'activation ci-dessous sont destinées à Claude sur le S24 après relecture et fusion. Codex ne les exécute pas, ne fusionne pas les PR et ne déclare aucune activation ou recette physique. Une PR ouverte fournit une interface en revue ; elle ne prouve ni sa présence dans le build actif ni sa qualification.

## Inventaire des interfaces

Les chemins sont complets. Les objets, corps, confirmations et états viennent du contrat du lot concerné. Les identifiants de recette sont des fixtures dédiées choisies par Claude ; aucune donnée bancaire ne doit servir de canary.

| Lot | Lecture / interface | Mutation native | Livraison / qualification |
| --- | --- | --- | --- |
| R1/R2/R3 | GET `/v1/runs`, `/v1/runs/{runId}`, `/v1/runs/by-client/{clientRunId}` ; GET `/v1/sessions/{sessionId}/turns?contract=2` | DELETE `/v1/runs/{runId}` (suppression, distincte de l’arrêt d’une exécution) | Contrats fusionnés ; runs financiers/confirmations protégés |
| R5 / P2-a | GET `/v1/control/automations?contract=2`, `/v1/automations/{id}` | POST `/v1/automations/{id}/enable`, `/disable`, `/run` ; DELETE `/v1/automations/{id}` | P2-a fusionné ; [R5 #31](https://github.com/sfar-amine/samantha-core/pull/31) fusionné b4c6704, objectif de latence à mesurer |
| P2-c / R10 | GET `/v1/control/requests/{REQ-n}?contract=2` | POST `/v1/control/requests/{REQ-n}/cancel` | P2-c fusionné ; [R10 #32](https://github.com/sfar-amine/samantha-core/pull/32) et [playbooks #16](https://github.com/sfar-amine/samantha-ui-playbooks/pull/16) en revue : session d'origine explicite, null pour anciennes demandes |
| P2-e | GET `/v1/control/diagnostic?contract=2`, `/v1/control/diagnostic/logs/{agent|installation|engineering}`, `/v1/control/diagnostic/export` | Aucune : export **GET**, sans opération durable | Fusionné ; métadonnées filtrées, export sans contenu brut ni secret |
| P2-b | GET `/v1/skills/{id}` | POST `/v1/skills/{id}/enable`, `/disable`, `/try` | [#24](https://github.com/sfar-amine/samantha-core/pull/24) en revue ; essai accepté ne signifie pas tâche terminée |
| P2-d | GET `/v1/control/memory?q=&kind=&offset=0&limit=20` | POST `/v1/control/memory/{eventId}/forget`, `/v1/control/memory/import/preview`, `/v1/control/memory/import` | [Core #26](https://github.com/sfar-amine/samantha-core/pull/26), [playbooks #15](https://github.com/sfar-amine/samantha-ui-playbooks/pull/15) en revue ; aperçu sans écriture, sélection explicite avant import |
| P2-f | GET `/v1/laptop-access/computers`, `/v1/laptop-access/pairings/{id}` | POST `/v1/laptop-access/pairings`, `/v1/laptop-access/pairings/{id}/commit` ; DELETE `/v1/laptop-access/computers/{id}` | Fusionné ; biométrie avant autorisation/révocation, dernière clé protégée |
| R6 | GET `/v1/agent/config` | POST `/v1/agent/config` avec révision opaque du GET et confirmation lorsque requise | Fusionné, y compris hash opaque #33 ; outils restent en lecture, capacités d'écriture indiquées dans la projection |
| R7 | GET `/v1/updates` | Aucune : les méthodes de mutation sont refusées | Fusionné #22 ; versions et releases préparées vérifiées, aucune route `/updates/update` ou `/updates/rollback` |
| R9 | GET `/v1/notifications/sources`, `/v1/control/notifications?contract=2` | Uniquement les routes enable/disable P2-a pour les items scheduled avec automationId | Fusionné ; incidents/situations non désactivables, états inconnus explicites, pas de route de mutation R9 ; sans P2-a actif, aucun interrupteur |
| R11 | GET `/v1/conversations/{sessionId}/metadata` | POST sur le même chemin : titre, épinglage ou modèle fermé | [#28](https://github.com/sfar-amine/samantha-core/pull/28) en revue ; modèle refusé pendant un run actif, aucun nouveau registre |
| R12 | GET `/v1/control/engineering` | Aucune | Fusionné #23 ; continuations du propriétaire existant, aucune réconciliation déclenchée par lecture |
| R13 | GET `/v1/capabilities/{id}` | Aucune | [Core #41](https://github.com/sfar-amine/samantha-core/pull/41), [playbooks #19](https://github.com/sfar-amine/samantha-ui-playbooks/pull/19) fusionnés 7118457 / 2ba0e72 : fiche registry, pas d'exécution ni promotion |
| R14 | GET `/v1/attachments/{id}/content` | POST `/v1/attachments` binaire, `/v1/attachments/share` | [#14](https://github.com/sfar-amine/samantha-core/pull/14) fusionné 0bf30ab ; id obligatoire, idempotence par contenu, limites/rétention de son contrat, aucune réservation de run à l'upload |
| R15 | GET `/v1/security/surfaces` | Aucune | [#30](https://github.com/sfar-amine/samantha-core/pull/30) en revue ; clients/transports observés, aucune révocation inventée |
| R16 | GET `/v1/runs/{runId}/approval` | POST sur le même chemin, seulement allow-once ou deny avec confirmation liée | [#36](https://github.com/sfar-amine/samantha-core/pull/36) fusionné aa09bad ; pending réel à qualifier, paiement exclu, aucune décision à partir d'un cache périmé |
| R17 | GET `/v1/whatsapp/allowlist`, `/{contactId}`, `/history`, `/{contactId}/note` | POST liste, PATCH/DELETE contact, PUT note sous `/v1/whatsapp/allowlist` | [Core #39](https://github.com/sfar-amine/samantha-core/pull/39), [playbooks #17](https://github.com/sfar-amine/samantha-ui-playbooks/pull/17) ; claim avant consommation biométrique, owner protégé, sweep dans le cycle santé existant |
| V5 | GET `/v1/voice/voices` | Choix `voice` lors de l'ouverture via POST `/v1/extensions/claw-live/token` ou `/prewarm`, socket existante | [#34](https://github.com/sfar-amine/samantha-core/pull/34) fusionné 61a1994 ; préférences Android, aucun PUT `/v1/voice/voice` ni stockage Companion, candidats fournisseur à qualifier |

L'inventaire décrit les lots connus lors de cette rédaction. Relire la version finale de chaque PR avant activation : un chemin 404 dans une ancienne version est un endpoint absent, pas un résultat de recette réussi. R8 reste en brouillon (#47). C2 est une clôture de continuations par Claude ; C4 ajoute uniquement des tests JVM (#45), sans écart runtime. A5 est clos selon Claude. Ce runbook ne déclare pas la recette des lots ouverts.

## Outils runtime et vue propriétaire claw-live

Les interfaces natives existantes (PR #12) comprennent GET `/v1/runtime/log?maxBytes=65536`, POST `/v1/runtime/restart`, POST `/v1/terminal/command`, GET `/v1/terminal/session` et POST `/v1/terminal/session/input` ou `/reset`. Le terminal est un shell réel, réservé au client natif loopback ; ce n’est ni un outil agent ni un routeur métier. Un redémarrage n’est pas un déploiement et ne remplace pas companion-deploy.sh. Claude vérifie les gardes des propriétaires avant tout effet et ne lance aucune commande bancaire ni lecture de secret. Les journaux peuvent contenir des données privées : consulter localement, partager seulement une preuve nettoyée.

La vue Contrôle publique utilise GET `/v1/control/activity/stream` (SSE). La vue propriétaire utilise le même flux avec `?view=owner` : le helper existant `claw-live.py --owner-json --history 60` restitue les dernières lignes avec timestamps réels et `replay:true`, puis les événements live, tags et aperçus nettoyés. Le flux public reste sans contenu privé. La vue owner est locale, limitée à deux flux actifs ; fermer la vue termine son enfant de lecture. Elle n’ajoute aucun store ou daemon. Claude vérifie readiness, reconnexion et absence de doublons, sans publier de transcript ni confondre ce journal avec une recette de la voix duplex.

## Récupération ADB native après reboot

Le correctif Android `f64513fb9e0830759b84768eb920c228f4faa8cb` réarme le débogage Wi-Fi via le `RecoverySignalReceiver` existant, hors du domaine Termux. Après le grant ADB initial vérifié de `WRITE_SECURE_SETTINGS`, il écrit uniquement `Settings.Global["adb_wifi_enabled"]=1`, relit cette valeur puis déclenche la réparation Tier0 existante. Déclencheurs existants : boot, remplacement du paquet, retour Wi-Fi avec capacité Internet et filet de sécurité de15minutes. Aucun nouveau scheduler ni shell arbitraire.

Le watchdog Termux reste propriétaire de la découverte d’endpoint, de la vérification du serial S24 et du transport canonique `127.0.0.1:5556`. Si le grant manque, ne pas annoncer un réarmement réussi. Claude vérifie successivement le grant de l’APK installé, un passage Wireless Debugging OFF→ON sous signal natif, puis la disponibilité ADB et le serial par le watchdog. Un reboot physique contrôlé reste une preuve distincte, avec Amine ; ni le SHA ni les tests JVM ne l’attestent. Le script de réparation ne doit jamais être remplacé par une commande d’effet parallèle.

## Réviser et préparer l'activation

1. Claude relève le SHA Companion relu, les SHA playbooks appariés et la version Android concernée. Il intègre par PR les bases actuelles ; aucune reprise d'un ancien bundle avec ses ancêtres non relus. Toutes les étapes CI existantes, notamment M1, restent présentes.
2. Codex fournit les preuves Git : build/tests ciblés, CI locale appropriée et notes de livraison `not_applied`. Chaque nouveau test doit être inscrit dans ci.yml dans la même PR. Toute nouvelle route ajoute à companion-acceptance.py une lecture avec budget ou une mutation refusée sans en-tête propriétaire (règle24). Les fixtures réelles et mesures S24 manquantes restent explicites.
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

La [PR propriétaire #35](https://github.com/sfar-amine/samantha-core/pull/35) fournit `installer/termux-lite/companion-deploy.sh` et `companion-acceptance.py`. Elle est fusionnée depuis `f1e1800` et ses scripts sont présents dans la base `0bf30ab` ; aucun déploiement Codex n’en découle. Le correctif propriétaire #46 conserve le verrou pendant les sous-processus du déploiement.

Claude utilise le script depuis sa localisation canonique validée. Il refuse un checkout modifié, une cible non descendante, la concurrence de jobs lourds ou une mémoire insuffisante. Il sauvegarde le `dist` Companion (cinq sauvegardes par défaut), avance rapidement le checkout, construit, redémarre, attend `/v1/health` puis fait sa recette automatique. Le caller doit lancer ce travail détaché pour survivre à la coupure du Companion ; le script conserve son propre log et reçu. Les commandes suivantes sont réservées à Claude, après vérification du SHA à déployer :

```sh
COMPANION_SHA='REMPLACER_PAR_LE_SHA_COMPANION_RELU_40_HEX'
nohup ~/ClawMobile/installer/termux-lite/companion-deploy.sh "$COMPANION_SHA" >/dev/null 2>&1 </dev/null &
~/ClawMobile/installer/termux-lite/companion-deploy.sh --status
```

En échec de build, santé ou recette, **le script restaure réellement le checkout précédent et le `dist` sauvegardé**, redémarre et vérifie à nouveau. Il écrit `rolled_back` si ce retour est sain ; sinon `rollback_failed` et un incident `human_required` via le propriétaire existant. Lire le reçu ; ne pas relancer le déploiement pour contourner un résultat incertain. `--status` est la seule option de consultation ; ne pas inventer `companion-deploy.sh --rollback`, ni utiliser une nouvelle intention Claw après une coupure.

Le [contrôleur Tier0](../../../../installer/termux-lite/tier0-control.py) porte séparément les releases des helpers Termux : `package`, `promote`, `rollback --reason`, `status`, `root`. Sa promotion peut demander le bootstrap existant ; son rollback vérifie le LKG et change le pointeur, **sans redémarrage automatique**. `tier0-bootstrap.sh --restart-core` relance les superviseurs existants quand Claude décide ce redémarrage. Un changement de ce pointeur ne restaure pas à lui seul le `dist` du plugin Companion : `companion-server.sh` construit le plugin du dépôt résolu par `lib.sh`. Garder cette distinction dans le reçu et la recette ; ne pas annoncer un rollback Companion sur la seule foi d'un pointeur Tier0.

La mémoire SQLite, les fichiers privés, les confirmations et les reçus restent dans leurs propriétaires. Aucun reset/suppression de ces données dans la procédure. Si un retour manuel hors déploiement échoué est nécessaire, Claude le prépare à partir de la sauvegarde et du SHA précédents vérifiés, sans détourner une route R7 absente ni toucher au paiement.

## Reconnexion Claw après restart

Le Companion peut couper le lien qui a lancé le déploiement. Après reconnexion, lire le reçu du déploiement engagé et sa santé ; une reconnexion n'est pas une preuve de réussite du build.

Depuis le dépôt playbooks, commande de lecture prévue pour Claude ou un diagnostic Codex explicitement autorisé :

```sh
python3 tools/claw_mcp_client.py call claw_context --args '{"query":"verifier le contexte et le snapshot runtime apres integration Companion, lecture seule"}'
```

Lire réellement tous les `required_reads` et vérifier la fraîcheur et la readiness. `readiness: blocked`, notamment une couverture globale insuffisante, empêche de présenter le contexte comme prêt ; ne pas fabriquer une attestation ni lancer un effet pour masquer ce blocage. Ne jamais afficher l'environnement, `CLAW_MCP_TOKEN`, un token fournisseur ou une réponse privée brute. Le loopback d'une tâche Codex Cloud n'est pas le S24.

Pour une opération déjà engagée et devenue incertaine, `claw_status` conserve exactement les mêmes action_key/step_key. Vérifier l'effet avant toute autre décision ; aucun rejeu sous une clé neuve. Si le transport reste indisponible, Claude utilise le diagnostic du propriétaire existant. Pas de second relais, daemon, route métier parallèle ou repli financier.

## Recette et clôture

G2 est fusionné (#43, d7ae8f1) : `openclaw-plugin-mobile-ui/scripts/runtime-contract-report.py`, son inventaire `runtime-contract-cases.json` et `docs/work/samantha-runtime/contracts/g2.md` sont les chemins convenus avec son propriétaire. Ces fichiers sont présents dans la base0bf30ab ; leur présence ne prouve pas une couverture complète sur le S24. Le rapport exerce uniquement les GET, sans envoyer de mutation. Les mutations non financières exigent leurs preuves offline obligatoires ; le paiement est exclu. Des états pending/unknown, une interface absente ou une preuve manquante empêchent la couverture complete. Aucun rejeu d'un effet pour fabriquer la preuve d'idempotence.

Fournir des identifiants dédiés pour les détails et distinguer absents, non exercés et réussis. Un 404 ignoré par l'ancien contrôle de déploiement ne remplace pas la couverture requise de G2. Ne pas exporter une réponse brute, un numéro, un nom de contact, une note ou une conversation. Le [plan G4 #42](https://github.com/sfar-amine/samantha-core/pull/42) réserve le ménage runtime à Claude après les qualifications ; aucune suppression S24 n'est effectuée par G3 ou G4 Git.

[V2 #37](https://github.com/sfar-amine/samantha-core/pull/37) teste la télémétrie historique ; [V4 #38](https://github.com/sfar-amine/samantha-core/pull/38) produit un rapport p50/p95 avec appariement sid/source et exclusion de dérive >1 ms. Les journaux du 10 octobre sont des preuves historiques, pas une nouvelle recette. [V3 #40](https://github.com/sfar-amine/samantha-core/pull/40) propose une requalification duplex sans écrire la route ; Claude la fait avant RDV1. V5 exige qualification de chaque candidat fournisseur et écoutes/mesures appropriées ; un setup de fixture ne qualifie pas la voix réelle.

G1 conserve les recettes déjà déclarées par Claude. G2/G3/G4 sont des livraisons Git ; activation, écrans, nettoyage S24, RDV1/M1 et décision finale restent avec Claude et Amine. La clôture globale exige les preuves de chaque lot et ses dépendances, sans déclarer G5 ni M1 validés faute de contrat/preuve.
