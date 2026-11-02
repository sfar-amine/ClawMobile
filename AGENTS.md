# AGENTS.md — samantha-core (Companion et runtime Samantha)

## Exception de livraison — chantier 1 uniquement (22 octobre 2026)

`CHANTIER1_AUTONOMOUS_DELIVERY_20261022` : le mandat explicite d'Amine dans le chat du 22 octobre 2026, confirmé après l'indisponibilité de Claude, autorise Codex à conduire seul les changements du chantier 1 « Intents IA / exécution déterministe » v2.3 jusqu'à leur livraison réelle : développement, contrôles de source, intégration, synchronisation, fusion, activation/déploiement, recette, nettoyage et retour arrière. Cette exception met en œuvre A12/A13, §0.5.2 et §18.1 du dossier, sans déduire une autorisation de la seule présence d'un texte dans un fichier.

Pour **ce seul chantier**, une revue Claude, un audit indépendant et un relecteur distinct ne sont pas des préalables. Les règles de rôle « Codex ne fusionne/déploie pas », « l'auteur ne s'auto-atteste pas » et « le relecteur rejoue dans son propre conteneur » sont remplacées dans cette portée par le mandat autonome explicite ; elles ne sont pas supprimées pour gagner du temps ou économiser des vérifications. Codex assume la responsabilité des contrôles et conserve les preuves, sans appeler ces contrôles une revue indépendante.

Restent obligatoires : CI canonique **hors téléphone**, head GitHub exact et numéro de PR, sortie durable citée, validation du contenu final intégré et des versions appariées, fixtures/provenances, portes G1–G6 applicables et limites `NOT_IMPLEMENTED` honnêtes, protections transactionnelles et humaines, secrets/données/fournisseurs, sauvegardes et rollback vérifiable. Aucun force-push, aucune nouvelle permission métier ou admission de données, aucun faux PASS LIVE ; une autorisation de déployer ne transforme pas une preuve manquante en réussite. Les scripts et propriétaires existants sont conservés.

L'exception ne change aucune règle pour les autres chantiers ; elle n'autorise pas de service, store, routeur ou ordonnanceur parallèle. Le [contrat de décision borné](docs/08-decisions/ADR-20261022-chantier1-autonomous-delivery.md) précise la portée et le retour au cadre ordinaire. Les règles ci-dessous continuent de s'appliquer, sauf ces seuls conflits de rôle et de relecture expressément remplacés.

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

## Le cerveau partout (décision d'Amine du 02/11/2026, règle globale)
Référence : `samantha-ui-playbooks/docs/08-decisions/ADR-20261102-brain-everywhere.md`. Elle remplace « déterministe d'abord » là où il y a conflit.
- **Une boucle sur toute surface** : WhatsApp, app et voix d'Amine, contacts des pièces, automatisations à modèle. Le modèle lit la demande, choisit un outil typé ou un skill, lit le résultat vérifié et rédige la réponse. Un seul chemin pour Amine et pour les contacts, sans interrupteur ni repli natif conservé à côté.
- **Le déterministe devient outil** : outils typés, Graph, propriétaires, coordinateurs et vérification portent les effets, les confirmations, les reçus et les faits vérifiés. Aucun hook (`before_dispatch`, `inbound_claim`…) ni réponse `handled: true` ne décide de l'intention à la place du cerveau. Toute voie de ce type est convertie, jamais ajoutée.
- **La sécurité reste au code** :
  - écritures par outils typés seulement ;
  - commande préparée, confirmation hôte ou politique de pièce, relecture du droit, relecture fraîche et vérification ;
  - aucun rejeu après un résultat indéterminé ;
  - paiement, biométrie et OTP humains ;
  - portée de la pièce et isolation des contacts ;
  - jamais de fait inventé.
- **Amélioration continue** : le cerveau propose ; la modification passe par learning gate, proposition, PR, CI, recette, puis activation avec retour arrière. Jamais de modification silencieuse en production.
- **Performance** : skill préchargé par l'hôte (#520), outils typés fréquents en `catalogMode: "direct-only"`, `skills_read` en un seul aller-retour, Tool Search gardé au-delà de 100 outils, préfixe de prompt stable en cache.

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
9. **Entrée canonique des consultations opérateur** (audit Orange du 10/10 ; règle runtime `OPERATOR_CANONICAL_ENTRY_V1` dans `samantha-ui-playbooks`). Toute consultation opérateur passe par l'entrée canonique de sa capability (registre puis Capability Graph ; Orange = `python -m telecom.maxit_guarded_service <intention> --mode auto`). Jamais d'appel direct à `telecom.service`, `cli`, `maxit_direct`, `maxit_retrieval` ni à l'app opérateur — ni par un agent, ni par un script, ni par une recette.
   - **Orange en 4G et en Wi-Fi (décision d'Amine du 17/10, « 4G et Wi-Fi », qui remplace la règle « 4G gardée » de l'audit du 10/10 et le repli HTTP 400 du 10/10).** Les parcours Orange/Maxit sont admis sur les deux réseaux. Le garde `with-consultation-receipt` choisit un seul chemin et l'atteste dans `network_guard.path` : `cellular_default` (4G déjà principale), `cellular_bound_wifi_unchanged` (Wi-Fi principal, authentification par le canal cellulaire attesté de l'app, Wi-Fi conservé), `guarded_fallback` (Wi-Fi coupé le temps de la lecture, puis restauré). Le canal réellement utilisé est attesté, jamais deviné. Quand Orange exige le cellulaire (identification de la ligne par le réseau) et qu'aucun chemin cellulaire n'est attesté, le parcours le dit avec sa raison, sans échec silencieux ; le Wi-Fi n'ouvre jamais de contournement d'authentification.
   - La recharge payante garde son parcours déterministe `with-wifi-off --purpose maxit-topup-payment`, inchangé : sur Wi-Fi elle n'exécute rien de plus qu'en 4G, avec les mêmes confirmations, et biométrie, OTP et 3-D Secure restent humains (`installer/termux-lite/test-payment-guard-invariance.py`).
   Un test sans réseau réel simule le wrapper ou le garde ; un test live passe par l'entrée canonique et son reçu prouve le chemin réseau et la restauration. Chaque route a un test CI qui fixe son entrée. Aucun résultat brut affiché à l'utilisateur. Vaut pour toute capability à parcours déterministe déjà développé : réutiliser, jamais court-circuiter.
10. **Une PR décrit** :
   - ses routes, avec leur budget et leur capability ;
   - ses tests, et s'ils sont dans la CI ;
   - ses fixtures et leur provenance ;
   - le retour arrière.

11. **CI locale, source unique — 17/10/2026.** L'unique programme de vérification vit dans `samantha-core/tools/localci.py` (branche de livraison Companion, non dans `installer/termux-lite/`) ; GitHub Actions reste volontairement inactif. Une PR n'est **vérifiée** que si la commande `python3 tools/localci.py <chemin-du-dépôt> <SHA-exact-du-head> <numéro-PR> <chemin-sortie>` retourne **0** et que le commentaire de PR cite ce SHA et la sortie conservée. Pour playbooks et contexte : `python3 ../samantha-core/tools/localci.py . <SHA-exact-du-head> <numéro-PR> <chemin-sortie>` ; un checkout frère de `samantha-core`, contenant ce fichier, est donc obligatoire. Le runner relit tous les `jobs` et les `run:` du workflow **au SHA demandé**, en worktrees détachés par job et en séquence ; aucun test n'est supprimé et aucun workflow n'est vidé. L'auteur ne s'auto-atteste pas : le relecteur rejoue la commande dans **son propre conteneur** sur le même SHA et cite sa propre sortie. Les chemins Node 20/22/26 sont des variables `LOCALCI_NODE20_BIN`, `LOCALCI_NODE22_BIN`, `LOCALCI_NODE26_BIN` avec repli ; Python 3.12 utilise `LOCALCI_PYTHON312_BIN` avec repli. **Sans PC (décisions d'Amine du 24/10, S24 `35b224a6` puis option 2) :** la preuve de fusion est ce `localci.py` exécuté dans le conteneur cloud de l'agent (Claude Code), jamais sur un PC ; le S24 sert aux recettes réelles. Sur le téléphone, `tools/localci-s24.sh <dépôt> <SHA> <PR|-> [fichier-description]` reste un **diagnostic**, pas une preuve de fusion. Ce lanceur récupère le head exact et `refs/pull/N/{head,merge}` par l'accès git du S24, puis exécute `localci.py` dans le Debian proot (outils de `tools/localci_s24_toolchain.sh`) avec un environnement vide. Le profil `s24` tient le verrou de déploiement en exclusif (un seul travail lourd ; occupé = rien ne démarre), baisse la priorité et donne aux étapes un HOME privé sans identifiants Samantha. Le journal et un reçu restent dans `~/.cache/localci-s24/logs/`. Pourquoi seulement un diagnostic : sous PRoot, Python est 2 à 3 fois plus lent qu'en Termux natif, donc les budgets de temps vérifiés par les tests y sautent de façon variable, et le bac à sable `bwrap` de l'intent lab playbooks n'a pas d'équivalent sur Android (ni espaces de noms utilisateur ni Landlock). Aucun budget n'est assoupli et aucune étape n'est sautée pour le S24. Termux sans ce profil est refusé, jamais contourné en silence. GitHub Actions reste une option seulement si son quota gratuit et l'absence de facturation sont attestés. Une PR/merge ne constitue pas un déploiement.

### Ligne app et préflight de la CI locale

Sur la ligne app de `samantha-core` (workflow `android-app.yml`, sans `ci.yml`), la même commande `tools/localci.py` vérifie d'abord le head et la base GitHub, puis délègue au propriétaire versionné `android/samantha/tools/build-apk-offphone.sh --out <répertoire>` dans un checkout détaché propre. Elle ne réimplémente pas les étapes Gradle. `SAMANTHA_DEBUG_KEYSTORE` est retiré de l'environnement, `--publish` n'est jamais passé, aucune installation n'est lancée. Le reçu doit porter le SHA exact, des tests et suites non vides, zéro échec/erreur/test ignoré, les versions des outils et une empreinte APK concordante. Le log indique le nombre de tests JVM ; `steps=1` désigne la délégation, pas un décompte des étapes Actions. Les artefacts sont conservés dans `<nom-du-log>-android/` à côté du log.

Avant tout worktree ou test, la CI refuse si le volume temporaire (`LOCALCI_TMP_ROOT` ou le temporaire système) ou le volume de sortie a moins de 1 Gio libres (2 Gio pour l'app). Ce plancher ne garantit pas qu'une compilation tiendra ; le runner n'efface aucune donnée de l'appelant. Réutiliser un répertoire d'artefacts Android existant est refusé pour éviter une preuve périmée : choisir un nouveau nom de log pour chaque rejeu.

## Déploiement (Claude)
- Uniquement par `installer/termux-lite/companion-deploy.sh <commit>`, qui fait dans l'ordre :
  - le préflight (refus si un job lourd tourne, si la mémoire est sous 1 200 Mo ou si la charge dépasse 7) ;
  - l'avance rapide uniquement ;
  - la recette automatique ;
  - **toutes les copies exécutées amenées au même commit** (`runtime-sync.sh`) : le plugin de la passerelle WhatsApp (`~/.openclaw/extensions`, puis redémarrage propre de la passerelle), la release Tier0 qui lui sert `model-fast-path.py` (`~/.openclaw/releases/current`, bornée à 10), et les outils de déploiement (`~/.openclaw/tools`). Une copie différente fait échouer le déploiement. Incident du 12/10 : la passerelle exécutait encore le plugin du 11/10, et la pièce Pulse répondait par le modèle ;
  - le **retour arrière automatique** si besoin (il ramène aussi ces copies) ;
  - les consignes des agents (pièces Projet et Pulse, contacts `contacts-agent.md`) suivent le même commit. Toutes les 30 min, le gestionnaire de santé lance `runtime-sync.sh --check`. Ce contrôle prouve que chaque copie, chaque consigne, les règles des playbooks et le contrat `before_dispatch` d'OpenClaw sont toujours alignés, et il alerte sinon ;
  - l'écriture du reçu dans `~/.openclaw/deploys/`.
- Playbooks : `activate-ui-playbooks.sh <sha>`, qui réinstalle aussi les règles globales (`install_interaction_rules.py --apply`).
- L'app Android est compilée **hors du téléphone**, en local (`./gradlew --no-daemon testDebugUnitTest assembleOptimized`, puis `android/samantha/tools/build-apk-offphone.sh --publish`), et non par GitHub Actions (décision d'Amine du 17/10). L'installation vérifie le checksum et la clé du S24. **Pas de Gradle sur le téléphone.**
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
