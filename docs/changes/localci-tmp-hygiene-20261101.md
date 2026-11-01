# localci : plus aucun dossier temporaire laissé derrière (2026-11-01)

## Constat
Le conteneur cloud accumulait environ 400 dossiers `/tmp/localci-python-*` (43 Mo chacun, environ 17 Go) et quelques `/tmp/localci-samantha-core-*` et `/tmp/localci-samantha-ui-playbooks-*`. Le disque passait sous le plancher de la CI et les runs suivants s'arrêtaient en `disk_space_insufficient`.

## Causes
1. `bin_for("python", ...)` créait pour chaque étape `actions/setup-python` un venv `localci-python-*` par `tempfile.mkdtemp` et ne le supprimait jamais, ni en succès ni en échec. Chaque run playbooks (job `docs`) en laissait un, et chaque run samantha-core aussi, via le test `test_versioned_python_gets_a_setup_python_environment` de `tools/test_localci.py` qui appelait `bin_for` directement.
2. Les copies de dépôt par job (`localci-<dépôt>-<job>-*`) étaient bien supprimées dans un `finally`, mais SIGTERM tuait le processus sans exécuter ce `finally`. Un run arrêté (timeout, agent interrompu, teardown) laissait donc la copie et le HOME privé S24.

## Correction
- Chaque dossier créé par localci (copie de job, venv, HOME privé S24, checkout du propriétaire du contrat de livraison, checkout Android) est une « scratch » marquée : `mkdtemp` sous un préfixe `localci-`, puis un fichier `.localci-owner.json` (PID, heure de démarrage du PID, espace de noms PID, boot, date) dont le verrou `flock` reste tenu pendant toute la vie du run.
- Un seul conteneur par job : la copie de dépôt est `<scratch>/workspace` et le venv Python `<scratch>/python3.12-*`. Les deux sont supprimés dans le `finally` du job, en succès, en échec et sur erreur du runner.
- En CLI, SIGTERM, SIGINT et SIGHUP déclenchent un déroulement : l'étape en cours est arrêtée (terminate, puis kill après 5 s), chaque `finally` supprime ses dossiers, puis le code de sortie vaut 128 + signal (`LOCALCI_RESULT exit=143 error=terminated_by_signal`). Un second signal pendant le nettoyage est différé, jamais autorisé à l'interrompre. Le subreaper du runner canonique transmet maintenant SIGTERM au run et lui laisse 10 s avant le SIGKILL.
- Purge au démarrage, avant le plancher disque : seuls les dossiers `localci-*` de premier niveau sous `LOCALCI_TMP_ROOT` (ou le temporaire système) et le temporaire système sont examinés. Pour être supprimé, un dossier doit être un vrai répertoire (pas un lien) du même utilisateur, avoir un marqueur régulier dont le chemin enregistré est le sien, être plus vieux que `LOCALCI_STALE_HOURS` (6 h par défaut, au moins 1 h), avoir un verrou libre et un PID propriétaire mort (ou réutilisé, ou d'un autre espace de noms PID). Un dossier non marqué n'est jamais touché, même s'il s'appelle `localci-python-*`.

## Venv partagé entre les jobs : refusé
Un venv réutilisé par tous les jobs d'un run ferait passer les `pip install` d'un job aux jobs suivants. Sur GitHub, chaque job démarre sur un runner neuf : un job pourrait alors réussir en local seulement parce qu'un job précédent a installé sa dépendance. La sémantique d'isolation des tests changerait. On garde donc un venv par job, mais dans la scratch du job : un seul existe à la fois (environ 43 Mo) et il disparaît avec le job. Le coût de création, environ 3 s par job qui utilise setup-python, reste faible.

## Limites
- Un SIGKILL (ou le teardown bwrap par SIGKILL du groupe) ne peut pas être intercepté : le dossier reste marqué, et la purge d'un run suivant le supprime une fois le verrou libre et le délai écoulé.
- Les dossiers déjà présents dans le conteneur, créés par l'ancienne version, ne portent pas de marqueur : la purge ne les supprime pas, par construction. Leur suppression reste une décision humaine.
- Une entrée de worktree Git d'un dossier purgé reste listée comme `prunable` dans le dépôt d'origine. `git worktree prune` la retire ; localci ne la retire pas pour ne pas toucher l'état d'autres outils.

## Retour arrière
Revenir sur le commit. Il n'y a rien à redéployer : outil de CI hors téléphone uniquement.
