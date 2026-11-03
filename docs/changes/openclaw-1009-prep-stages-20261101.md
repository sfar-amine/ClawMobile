# OpenClaw 2026.10.9 — variante du jeu `gateway-prep-stages` et triage automatique au démarrage

## Contexte

La répétition isolée de la montée OpenClaw 2026.9.6 → 2026.10.9 sur le S24 (01/11) a relevé deux préalables :

- A. le jeu de compatibilité `gateway-prep-stages` refusait la 2026.10.9 (`unsupported_package_version`) ;
- B. quand le démarrage de la Gateway échoue, OpenClaw lance de lui-même un triage qui peut appeler un modèle :
  « Starting claude… Not logged in » dans le journal du candidat isolé.

## A — le manque existe encore en 2026.10.9 : variante écrite

Le jeu 2026.9.6 (L0bis, `refonte-l0bis-sdk-prep-stages-20261026`) ajoute des points de mesure au tracker existant,
sans rien d'autre : 11 checkpoints `plugin-tools:*` passés par le callback `recordToolPrepStage`, et 8 sous-spans
`system-prompt:*` via `prepStages.measure` et `measureSync`. Il comble un manque de diagnostic : le span plugins ne
permettait pas de savoir où partaient les 11 s.

Dans `openclaw@2026.10.9` (npm, archive sha256 `43c61a00…`), le manque est toujours là :

- `openclaw-tools-CSSYZDKR.mjs` n'émet que les mêmes `openclaw-tools:*` qu'en 2026.9.6 ;
- aucun `plugin-tools:*` ni `system-prompt:*` n'existe dans `dist/` ;
- `prepareEmbeddedAttemptSystemPrompt` ne fait toujours qu'un `params.setup.prepStages?.mark("system-prompt")` global.

Variante `packages["2026.10.9"]` du même manifeste, appliquée par le même propriétaire
(`whatsapp-network-recovery.py --patch-set gateway-prep-stages`) :

- `openclaw-tools-CSSYZDKR.mjs` et `tools-DQdRObqo.mjs` : remplacements **identiques** à ceux de 2026.9.6.
  `resolveOpenClawPluginToolsForOptions` n'a pas changé. Dans `resolvePluginTools`, l'amont n'a changé que des
  détails sans rapport avec les ancres.
- `attempt-system-prompt-prepare-ChKsbjSh.mjs` : c'est là qu'est passée la préparation du system prompt. Les mêmes
  8 sous-spans y sont posés, avec trois différences :
  - `setup.prepStages` est optionnel en 2026.10.9, car le tour worker (`worker-turn-execution`) n'en passe pas. Un
    repli local `prepStageSpans` exécute alors la fonction telle quelle, sans rien mesurer ;
  - `buildAttemptSystemPrompt` est devenu asynchrone : on le mesure avec `measure` ;
  - les références passent par `params.referencePaths ?? …` : le span n'existe que si on les résout vraiment.

Le jeu 2026.9.6 reste inchangé, octet pour octet. Aucun hook de démarrage, de synchronisation ou de déploiement
n'active ce jeu : l'activation reste explicite, par root.

Fixtures : les trois modules publics gzippés dans `openclaw-plugin-mobile-ui/fixtures/openclaw-2026.10.9-compat/`
(README). Le tracker `stage-timing-BUG4Fnsv.mjs` de 2026.10.9 a les mêmes octets que la capture S24 2026.9.6.

Tests : `installer/termux-lite/test-gateway-prep-stages-1009.py` (5 tests, inscrit en CI dans l'étape du jeu) couvre :

- l'application atomique, idempotente et réversible, et les empreintes ;
- le refus avant toute écriture sur un module inconnu ou une autre version ;
- le jeu 2026.9.6 inchangé ;
- le comportement des corps originaux et patchés dans un harness VM : retours, effets, erreurs, callback absent,
  registre réutilisé ou chargé, tour worker sans tracker, et agrégat `system-prompt` parent conservé (73 ms) ;
- `node --check` des trois modules patchés ;
- aucune activation implicite et aucun chevauchement avec les autres variantes 2026.10.9.

## B — triage automatique au démarrage : mécanisme décrit, pas de réglage posé

Mécanisme (2026.10.9, `dist/`) :

1. `run-HO6sETAH.mjs`, dans `runGatewayCommand`, la closure `triageStartupFailure` est appelée sur l'échec final du
   démarrage, et aussi via `onRestartStartupFailure` lors d'une relance. Elle sort sans rien faire si :
   - le boot n'a pas été enregistré ;
   - le signal a été annulé ;
   - l'erreur est un verrou, une config invalide, un conflit Tailscale ou de config effective, un nettoyage ou une
     maintenance ;
   - un superviseur ou `OPENCLAW_SERVICE_MARKER` est présent, sauf si le disjoncteur de boucle de crash écrit un
     bundle.

   Sinon elle appelle `triageGatewayStartupFailure`, puis `triageAfterFailure` avec `kind: "gateway-startup"`.
2. `triage-failure-DoR3aje_.mjs`, fonction `triageAfterFailure` : la seule garde d'entrée est
   `if (process.env.OPENCLAW_SHELL === "exec" || process.env.CODEX_THREAD_ID || isGatewayExternallySupervised() || signal?.aborted) return;`.
   Sur Termux, `process.platform` vaut `android`, donc `detectRespawnSupervisor` renvoie `null`. Le triage part
   alors dans `continueTriageInFreshProcess`, qui lance `openclaw triage` dans un nouveau processus.
3. `triage-DPawCmqU.mjs`, fonction `triageCommand`, en mode automatique : le triage choisit son agent ainsi :
   - si la config est valide et que l'agent propriétaire a un modèle primaire (`runEmbedded`), c'est une réparation
     embarquée par le modèle configuré (`runAutomaticTriageRepair`), avec exec, write et edit si la politique le
     permet ;
   - sinon, c'est le premier de `claude` ou `codex` trouvé sur le PATH : `claude -p` (ou `--safe-mode -p`) avec le
     prompt de diagnostic sur stdin, pendant 600 s au plus.

   Le candidat isolé n'avait pas de config valide, d'où « Starting claude ». En production, la branche embarquée est
   la plus probable, avec le même effet : un tour de modèle non supervisé.
4. Le claim : `continueTriageInFreshProcess` (`triage-continuation-h3pc7P63.mjs`) prend un bail `triage` dans
   `$TMPDIR/openclaw-<uid>/managed-update-handoffs.sqlite`, une ligne par racine d'installation. Si le nettoyage est
   incertain (arrêt forcé après 30 s de grâce, ou libération impossible), le bail reste `uncertain` : « automatic
   admission remains blocked for this OS boot … do not delete the claim ». Toute autre admission gérée sur cette
   racine répond `busy` jusqu'à un autre boot vérifié.

Réglage : 2026.10.9 n'a **aucune clé de config** ni variable dédiée. Les seuls interrupteurs sont les trois gardes
ci-dessus :

- `OPENCLAW_SUPERVISOR_MODE=external` est documenté, mais il change aussi :
  - le mode du verrou Gateway (`supervised`) et la relance (`runExternalSupervisorRestart`) ;
  - la mise à jour automatique (désactivée) ;
  - la possession de l'état partagé ;
  - la liaison de stockage des transcripts, qui compare cette variable entre processus.
- `OPENCLAW_SHELL=exec` sert aussi de nom de shell détecté, et il fait refuser les RPC de message aux CLI enfants.
- `CODEX_THREAD_ID` n'a qu'un seul consommateur dans `dist/`, mais il signifie « tour Codex ».

**Rien n'est posé dans `gateway-start.sh`.** La condition « sans effet en 9.6 » est fausse : `openclaw@2026.9.6`
(installé aujourd'hui) contient le même mécanisme, avec la même garde (`triage-failure-BI1ymYSt.mjs`, ligne 19) et
le même appel depuis `run-S_R0Bn7l.mjs`. Ce risque existe donc déjà en production. Toute variable posée changerait
le comportement actuel : la décision et la recette S24 reviennent à Claude et Amine.

## Retour arrière

Revenir sur ce commit. Le jeu 2026.9.6 est identique octet pour octet, et rien n'applique ce jeu automatiquement. Si
la variante a été appliquée à la main sur une 2026.10.9 :

1. `whatsapp-network-recovery.py --patch-set gateway-prep-stages --rollback` ;
2. redémarrer avec le propriétaire Gateway existant ;
3. vérifier les empreintes originales.

**NO_CAPABILITY** : aucune route, action ou capability ajoutée. Le paiement n'est pas touché.

Ajout pendant la qualification : `installer/termux-lite/test-qa-room-access.py` écrit maintenant le fichier de PID du SDK factice de façon atomique (fichier temporaire puis `os.replace`). La CI locale du 01/11 a lu une fois ce fichier encore vide sous charge (JSONDecodeError), sans lien avec la variante 10.9.
