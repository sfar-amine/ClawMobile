# Racine de code unique : la production exécute l'épingle activée (02/11/2026)

Décision d'Amine du 02/11/2026 : le code de production de Samantha tourne depuis une seule racine, l'épingle
activée. Les copies de travail (`~/.openclaw/workspace/ui-playbooks`, le checkout `~/ClawMobile`) deviennent des
copies de développement : y éditer ou y committer n'est jamais un déploiement silencieux. Contrainte d'Amine :
aucune rigidité. Aucun service n'est refusé au démarrage, aucun parcours qui marche n'est gelé ; quand l'épingle
manque, on se replie sur la copie de travail et on alerte.

## Ce qui change

- **Résolveur commun, épingle d'abord** (`installer/termux-lite/code_root.py`, `src/companion/playbooksRoot.ts`) :
  racine explicite, puis `~/.openclaw/runtime-ui-playbooks/current` (lien conservé tel quel, donc chaque
  activation et chaque retour arrière sont suivis), puis la copie de travail. Le repli laisse un fichier
  d'événement borné (`~/.openclaw/health/code-root/events/<composant>.json`, un par composant, réécrit au plus
  toutes les 10 min, 64 fichiers au plus). Aucun nouveau démon, store ni ordonnanceur.
- **Appelants passés à l'épingle** : `mcpBridge.ts` (`request_context.py`, `continuum_ingress`, résolus à chaque
  appel et non plus au chargement du module), `claw-job-run.sh` (`scheduling/runner.py`),
  `learning-gate-close.sh` et `context-dream.sh` (`skill_intelligence.improvement`). Les cas déjà « épingle
  d'abord » signalent désormais leur repli : `claw-capability.py`, `model-fast-path.py`, `voiceRoundLearning.ts`,
  `control.ts`. `clawmobile` recompile les vues si l'épingle ou la copie porte le graphe.
- **Learning gate** (`learning-gate.py`) : la capture reste instantanée. Les HOW-TO et le journal sont écrits dans
  les données de la porte (`~/.openclaw/learning-gate/howto/`, `~/.openclaw/learning-gate/journal/`), hors de tout
  dépôt. Le registre n'est plus jamais écrit : un changement de vérité devient seulement le candidat existant
  `registry-candidates/<id>.json`, enrichi d'une `proposal` (note et preuve à ajouter) qu'un lot suivant
  transformera en PR. Le registre lu est celui de l'épingle.
- **Redémarrage du Companion** (`companion-server.sh`, `lib.sh`) : la reconstruction du plugin et la
  resynchronisation de l'espace de travail ne se font que si le checkout est propre (même contrôle que `run.sh`,
  factorisé dans `clawmobile_source_dirty`) et si son HEAD est le commit de la release déployée (ou le commit
  candidat que `companion-deploy.sh` exporte pour son propre redémarrage). Sinon le Companion démarre sur le build
  déployé, sans reconstruire ni resynchroniser, et laisse un événement. Sans build du tout, il construit quand même
  pour démarrer (événement `built_unverified`). Sans release Tier0 (installation, poste de dev), comportement
  inchangé.
- **Contrôle de dérive** (`runtime-sync.sh --check`, toutes les 30 min par le gestionnaire de santé, sans toucher
  à `samantha-health-manager.sh`) : dérives nommées `code_root:<composant>:<événement>` (repli récent, 2 h),
  `code_root:playbooks_pin_missing`, `working_copy:core_dirty`, `skills:changed_since_activation` (empreinte de
  `~/.openclaw/workspace/skills` contre la dernière activation ou le dernier déploiement) et
  `job_root:<clé>` (job planifié encore lancé depuis une copie de travail). Les copies de développement sont
  rapportées dans un champ `advisory` sans alerte : `working_copy:playbooks_dirty`,
  `working_copy:playbooks_head_<sha>_pin_<sha>`, `skills:no_activation_baseline`,
  `job_root_exception:samantha:nightly-acceptance`. Le champ n'apparaît que s'il est non vide.
- **Migration des jobs S24** (`job_code_root.py`, revue, idempotente) : lancée par `activate-ui-playbooks.sh`
  après chaque activation (et sur `ALREADY_ACTIVE`) et par `runtime-sync.sh` à chaque déploiement, jamais
  bloquante. Elle lit d'abord le store en lecture seule ; s'il n'y a rien à faire, aucun appel au scheduler.
  Sinon, par `openclaw cron edit`, seuls `argv`/`cwd` changent, chaque job est relu (le reste du job doit être
  identique, sinon l'original est remis), l'original est sauvegardé dans `~/.openclaw/backups/job-code-root/`.
  Un job en cours ou dont la cible manque dans l'épingle est laissé tel quel et rapporté.

| Job (clé) | Avant | Après |
| --- | --- | --- |
| Samantha Agenda Sync (`samantha:agenda:sync-v2`) | cwd copie de travail | cwd `…/runtime-ui-playbooks/current` |
| Point personnel des taches (`samantha:todos:daily-1000`) | `cd $HOME/.openclaw/workspace/ui-playbooks` | `cd $HOME/.openclaw/runtime-ui-playbooks/current` |
| Claw — Bilan quotidien (`samantha:immune:daily-1700`) | cwd copie de travail | cwd `…/runtime-ui-playbooks/current` |
| Context Compactor (`samantha:context-compactor`) | `$HOME/ClawMobile/installer/termux-lite/…` | `$HOME/.openclaw/releases/current/termux-lite/…` |
| Context Guardian (`samantha:context-guardian`) | idem | idem |
| Cross-surface Memory Curator (`claw:cross-surface-memory-curator`) | idem (chemin absolu) | idem (chemin absolu) |

Engineering Maintenance et Recette nocturne tournaient déjà sur l'épingle playbooks. La Recette nocturne garde le
checkout core : elle recette le code déployé lui-même (exception rapportée en `advisory`).

## Tests

- `installer/termux-lite/test-code-root.py` (nouveau) : épingle présente → épingle sans événement ; épingle
  absente → copie de travail, job exécuté quand même, un seul événement (limité) ; override sans le fichier
  ignoré ; contrôle de dérive (événement récent ou ancien, checkout core sale, copie playbooks sale ou en avance,
  empreinte des skills, dossiers d'état `.openclaw` exclus) ; garde du Companion (`ok`, `dirty`, `head_differs`,
  candidat de déploiement, release illisible, sans release) ; câblage activation et déploiement.
- `installer/termux-lite/test-job-code-root.py` (nouveau), sur la capture S24 du 02/11
  (`fixtures/s24-2026-11-02-job-code-root`) : les six jobs nommés, l'exception nocturne, migration d'argv/cwd
  seuls, idempotence, aucun appel au scheduler sans travail, job en cours et cible absente laissés tels quels,
  relecture divergente remise à l'original, retour arrière exact, store lu sans écriture, réconciliateur du
  curateur toujours compatible.
- `openclaw-plugin-mobile-ui/scripts/test-playbooks-root.cjs` (nouveau) : résolution TS, événement limité,
  overrides, appelants sans racine de travail en dur.
- Mis à jour : `test-learning-gate.py` (registre jamais écrit, candidat avec proposition, chemins de données),
  `test-runtime-sync.py` (dérive de racine et ligne de base enregistrée au déploiement),
  `test-no-hardcoded-clawmobile.py` (liste blanche justifiée de `job_code_root.py`).
- Toujours verts : `test-runtime-sync.py`, `test-activate-ui-playbooks.sh`, `test-context-dream.py`,
  `test-memory-curator-cron.py`, `test-claw-capability-agent-policy.py`, `test-slack-runtime-contract.py`,
  `test-model-fast-path-*.py`, `test-engineering-runtime-bridge.py`, `test-ci-registration.py`, et côté Node
  `test-control-runtime-snapshot.cjs`, `test-mcp-foundation.cjs`, `test-mcp-context-*.cjs`,
  `test-mcp-read-owner.cjs`, `test-mcp-remember.cjs`, `test-runtime-root.cjs`.

Les trois nouveaux tests sont inscrits dans `.github/workflows/ci.yml`.

## Routes, capabilities, fixtures

Aucune route ni capability ajoutée ou modifiée. Fixture : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-job-code-root`,
capture nettoyée de la table `cron_jobs` du S24 (lecture seule, 02/11/2026).

## Ordre de déploiement

1. Fusionner et activer la PR playbooks correspondante (`delivery_sync` sans avance rapide ni poussée, installeurs
   sur l'épingle) par `activate-ui-playbooks.sh <sha>`.
2. Déployer ce core par `companion-deploy.sh <commit>` : `runtime-sync.sh` migre les jobs et enregistre la ligne
   de base des skills. Les activations suivantes rejouent la migration (idempotente).
3. Vérifier `runtime-sync.sh --check` : plus aucun `job_root:*` ; `cron_jobs` relu en lecture seule.

## Limites

- Les modules playbooks appellent encore des helpers core par `~/ClawMobile/installer/termux-lite/…`
  (`whatsapp-owner-send.sh`, `incident-email.sh`, `context-event.sh`…). Ce checkout est le checkout déployé
  (avance rapide seulement, refusé s'il est sale) et sa propreté est désormais une dérive alertée.
- Le Companion s'exécute toujours depuis le checkout déployé ; seule sa reconstruction est gardée.
- Une modification manuelle des skills faite avant un déploiement est absorbée par la ligne de base de ce
  déploiement.

## Retour arrière

- Jobs : `python3 ~/ClawMobile/installer/termux-lite/job_code_root.py --rollback` remet l'argv/cwd d'origine de
  chaque job migré (sauvegardes dans `~/.openclaw/backups/job-code-root/`).
- Code : revert de ce commit puis `companion-deploy.sh <commit précédent>`. Les HOW-TO et le journal déjà écrits
  dans `~/.openclaw/learning-gate/` restent lisibles ; les candidats de registre restent dans
  `registry-candidates/`.
