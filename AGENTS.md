# AGENTS.md — samantha-core (Companion et runtime Samantha)

Ces règles s'appliquent à tout agent qui modifie ce dépôt (Codex, Claude) et à toute PR. Elles viennent des incidents réels du 10/10/2026 :
- 503 notifications ;
- format de hash R6 ;
- R7 trop lent ;
- R15 au-delà de 500 reçus ;
- R5 toujours « deferred » ;
- verrou de déploiement ;
- filtre de fuite.

Le S24 reste la source de vérité opérationnelle (`claw_context`). Une copie Git n'est jamais l'état courant.

## Rôles
- **Codex** développe sur des branches et ouvre des PR. Il ne fusionne pas et ne déploie pas.
- **Claude** relit, fusionne, déploie sur le S24 et fait les recettes réelles.
- **Un commit ou une PR n'est jamais un déploiement.** On ne dit pas « fait » sans SHA, branche et reçu.

## Frontières non négociables
- **Le parcours de paiement déterministe** (de la biométrie jusqu'à la fin) n'est jamais modifié par un autre lot. Biométrie, OTP, codes bancaires et 3-D Secure restent humains.
- **Aucun secret** dans Git, les logs, les reçus ou les réponses : jetons, cookies, `.env`, OTP, données de paiement, e-mails de compte.
- **Propriétaires canoniques réutilisés.** Pas de nouveau store, registre, routeur, scheduler, démon ou moteur de retry si un propriétaire existe déjà.

## Règles de livraison (chaque PR)
1. **Fixtures réelles.** Toute route qui lit le Gateway ou un fichier ou une base du runtime est testée avec des captures nettoyées du S24, sous `openclaw-plugin-mobile-ui/fixtures/`, jamais seulement avec des formes inventées. **Toute source de vérité runtime (chemin, table, format) est confirmée sur le S24 avant le code.** Demande la capture à Claude.
   - Exemple : sur le S24, les tâches planifiées sont dans `state/openclaw.sqlite`, table `cron_jobs`, et non dans `cron/jobs.json`.
2. **Budget de temps par route**, vérifié en CI avec une latence réaliste (Gateway CLI : 2 à 10 s) **et** en production.
3. **Volumes réalistes** : plus de 100 releases, plus de 50 000 reçus, plus de 200 000 événements mémoire, plus de 500 fichiers.
4. **Aucun appel Gateway par ligne de liste.** Une lecture par page, avec un cache court ou le pool Control.
5. **Toute nouvelle route ajoute sa ligne** dans `installer/termux-lite/companion-acceptance.py` : une lecture avec son budget, ou une mutation qui doit être refusée sans l'en-tête propriétaire. Une réponse ne doit pas rester `deferred` au-delà de 15 s.
6. **Tout nouveau test est inscrit dans `.github/workflows/ci.yml`, dans la même PR.** En cas de conflit, on fait l'union : on garde toutes les étapes.
7. **Tout ce qui grossit est borné** : sauvegardes, reçus, journaux, releases, caches.
8. **Capabilities.** Toute action, tout réglage et toute information de l'app accessible à l'agent ou à la voix est une capability `samantha.app.*` du registre canonique (`samantha-ui-playbooks/capabilities/registry.json`), avec son `execution` (route), ses exemples en français, son `risk` et sa `confirmation_required`.
   - Une route owner sans capability est listée dans `NO_CAPABILITY`, avec sa raison.
   - Aucun outil ni pré-routeur parallèle aux capabilities, dans la voix, l'app ou le Companion.
9. **Une PR décrit** :
   - ses routes, avec leur budget et leur capability ;
   - ses tests, et s'ils sont dans la CI ;
   - ses fixtures et leur provenance ;
   - le retour arrière.

## Déploiement (Claude)
- Uniquement par `installer/termux-lite/companion-deploy.sh <commit>`, qui fait dans l'ordre :
  - le préflight (refus si un job lourd tourne, si la mémoire est sous 1 200 Mo ou si la charge dépasse 7) ;
  - l'avance rapide uniquement ;
  - la recette automatique ;
  - le **retour arrière automatique** si besoin ;
  - l'écriture du reçu dans `~/.openclaw/deploys/`.
- Playbooks : `activate-ui-playbooks.sh <sha>`.
- L'app Android est compilée par GitHub Actions et installée par `android/samantha/tools/install-from-ci.sh`, qui vérifie le checksum et la clé du S24. **Pas de Gradle sur le téléphone.**
- **Un seul job lourd à la fois** sur le S24.
- Toute route à plus de 80 % de son budget dans un reçu devient une tâche d'optimisation.

## Accès au S24 et au contexte canonique
- **Claude** (chat, Cowork, Code) : connecteur MCP « Claw ». Commencer par `claw_context` avec l'intention précise, puis lire tous les `required_reads`.
- **Codex Cloud** : `python3 tools/claw_mcp_client.py call claw_context --args '{"query":"…"}'` (outil et règles d'accès dans `samantha-ui-playbooks/AGENTS.md`, section « Accès Claw/S24 »). Le jeton `CLAW_MCP_TOKEN` n'est jamais affiché ni committé.
- **Codex Desktop / Claude Code sans MCP** : demander à Claude, ou passer par le client ci-dessus.
- **Documents du programme** : `samantha-ui-playbooks/docs/work/samantha-convergence/README.md` (index, état `11`, revues et lots récents). Sur le S24, la règle `SAMANTHA_PROGRAM_V1` y renvoie.

## Questions et réponses entre agents
Deux canaux existants, sans nouveau service :
- **Code** (lots, PR, revues) : commentaire de PR ou d'issue GitHub. On écrit `@codex …` pour Codex ou `@claude …` pour Claude, et la réponse se donne au même endroit.
- **Contexte et décisions** (toutes surfaces) : sur le S24, `context-event.sh <surface> open_thread "<question>"`, puis `decision --supersedes <id>` pour la réponse. `claw_context` les sert à chaque session.
- **Besoin d'Amine** : `incident-notify.sh human_required` (existant).
- **Une réponse qui fait foi** est reportée par PR dans les documents du programme.

## Où sont les détails
- Runbooks runtime : `docs/work/samantha-runtime/runbooks/` (G3, en cours de PR).
- Contrats par lot : `docs/work/samantha-runtime/contracts/`.
