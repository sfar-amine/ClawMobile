# F4.3 — Inventaire des composants qui suivent la release

Audit de la ligne Companion `runtime/samantha-companion-private`, source `6592da8ed400b819c21cd712a12f2ff7c177e41f`, le 18 octobre 2026. Le point F4.3 du document 63 demande de généraliser la règle déjà apportée par #307 : **un processus vivant sur une release précédente est réaligné sans consommer le budget de panne**. L'audit ne trouve pas de nouvelle divergence source démontrée dans les propriétaires actuels ; aucun deuxième mécanisme de réalignement n'est ajouté.

## Inventaire et propriétaires existants

| Composant | Propriétaire du réalignement | Comportement dans la source auditée |
|---|---|---|
| `samantha-root-guardian.sh` | `samantha-health-manager.sh:check_supervisor` | Processus vivant hors racine attendue : remplacement `stale_runtime`, `budget=exempt`, sans `restart_gate` ; absent : garde de redémarrage conservé |
| `adb-recovery-watchdog.sh` | Même `check_supervisor` | Même branche commune, avec attente du verrou canonique |
| `remote-desktop-watchdog.sh` | Même `check_supervisor` | Même branche commune, avec attente du verrou canonique |
| `incident-manager.sh` | Même `check_supervisor` | Même branche commune, avec attente du verrou canonique |
| `claw-slack-bridge.mjs` | `samantha-health-manager.sh:check_slack_bridge` | Vivant hors racine courante : remplacement gratuit ; absent ou dégradé sur la racine courante : garde conservé ; une attention de livraison ne force pas un redémarrage |
| `samantha-health-manager.sh` | `samantha-root-guardian.sh:ensure_supervisor` | Compare le chemin de script du processus à la racine Tier0 résolue à chaque boucle ; remplace le processus précédent sans budget ni ouverture d'incident |
| `incident-orchestrator-worker.sh` | Même `ensure_supervisor` | Même comparaison et remplacement ; les travaux d'incident restent dans leur propriétaire existant |
| `tier0-watchdog.py` | Même guardian, copie stable `~/.openclaw/tier0/bin` | Ne suit pas un chemin de release ; l'installation Tier0 remplace les outils stables par le propriétaire existant |
| Companion `dist/companion/server.js` | Déploiement Companion et `check_http` | Racine du checkout intentionnelle, pas la release Tier0 ; ne pas lui appliquer un réalignement supposé par URL |
| Gateway OpenClaw | Propriétaire Companion | Le gestionnaire de santé observe la disponibilité ; aucun nouveau propriétaire de redémarrage n'est créé |

Les anciens `adb-recovery-supervisor.sh` et `remote-desktop-supervisor.sh` existent dans l'arbre, mais aucune référence de lancement n'a été trouvée dans les points bootstrap, installateurs et déploiement inspectés. Ce constat de source ne prouve pas leur absence sur le téléphone ; une observation contradictoire imposerait de demander une capture avant tout changement.

## Source opérationnelle et limites

Claude a fourni une [observation S24 nettoyée du 18/10 à 10:35](https://github.com/sfar-amine/samantha-ui-playbooks/pull/189#issuecomment-6248307144) : root guardian, health manager, incident orchestrator et Slack suivaient `~/.openclaw/releases/20261018T020755-d3beb769/termux-lite`, alors que Companion tournait depuis le checkout `~/ClawMobile/installer/termux-lite`. Les deux racines sont intentionnelles. Il s'agit d'une observation rapportée par Claude, pas d'une capture directe Codex ni d'un reçu de déploiement de la présente PR.

L'inventaire des trois watchdogs/incident manager supplémentaires repose sur les appels de `check_supervisor` dans la source. Leur présence et leur racine au moment d'une recette réelle restent à confirmer par Claude. L'audit ne transforme pas cette inspection de code en preuve runtime.

L'assainissement de l'environnement hérité du pont (décision D) n'est pas inclus. Aucun environnement, paiement, chemin vocal direct ou processus S24 n'est modifié.

## Preuves rejouables

Les suites existantes, déjà inscrites dans `.github/workflows/ci.yml`, ont été rejouées sur la source auditée :

| Commande | Résultat ciblé | Ce que cela prouve |
|---|---|---|
| `python3 installer/termux-lite/test-health-restart-escalation.py` | 8/8 | Cinq réalignements simulés du superviseur, même depuis `human_required`, n'épuisent pas le budget ; un superviseur absent reste soumis à la garde ; escalade, déduplication et réinitialisation du budget conservées |
| `python3 installer/termux-lite/test-slack-runtime-contract.py` | 6/6 | Contrats de chemin réel des processus et de verrou ; disponibilité Slack distincte de l'attention de livraison |
| `python3 installer/termux-lite/test-tier0-control.py` | 15/15 | Contrôle Tier0 et câblage bootstrap/guardian, sans installation réelle |

Total ciblé : **29/29 vertes**. Il n'y a ni nouveaux tests miroir ni changement de production. La CI locale intégrale sur le head documentaire exact et le numéro de PR reste nécessaire avant qualification, et sa sortie est citée dans la PR.

## Critère de clôture et recette

Le code commun existant couvre déjà la règle demandée : pas de correctif redondant à publier. Le critère opérationnel « cinq déploiements dans l'heure sans incident de réalignement » reste une recette S24 appartenant à Claude ; cinq itérations simulées ne valent pas cinq déploiements réels. Une PR, son merge ou sa CI ne constitue pas cette recette. Si Claude constate un processus supplémentaire qui suit une release sans passer par ces propriétaires, son observation précise permettra un correctif ciblé.

Retour arrière : retrait de ce document uniquement ; aucun état runtime ou format de fichier ne change.
