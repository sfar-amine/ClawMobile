# Le cerveau partout, étape 3 : `SAMANTHA_BRAIN_ONLY` inconditionnel

Date : 2 novembre 2026. Base : `runtime/samantha-companion-private` 653b3942. Non déployé.

## Pourquoi

Décision d'Amine du 02/11 (ADR « le cerveau partout », samantha-ui-playbooks `docs/08-decisions/ADR-20261102-brain-everywhere.md`, annexe d'inventaire §2 et §8, étape 3). Le modèle lit la demande, choisit un outil typé, lit le résultat et rédige la réponse. Le code déterministe n'existe plus que sous forme d'outils ou de skills appelés par le modèle.

Sur le S24, `SAMANTHA_BRAIN_ONLY=1` est actif depuis le 28/10 : il est déclaré à la ligne 7 de `~/.openclaw/.env`, et les processus Node de la Gateway et du Companion le portent (lecture seule du 02/11). Les branches qui tournaient sans lui sont donc mortes en production. Règles d'Amine : un seul chemin, aucun interrupteur conservé, aucun repli natif.

## Ce qui change

Core ne lit plus `SAMANTHA_BRAIN_ONLY`, ni en TypeScript ni en Python. Les branches legacy owner sont supprimées :

- **WhatsApp owner** :
  - `modelFastPath.ts` : suppression de `handleOwnerBeforeDispatch`, `handleOwnerFastPath`, `isOwnerFastPathEligible` et `isTrustedLocalCompanionSession` ;
  - `index.ts` : suppression du hook `inbound_claim` et de la branche owner de `before_dispatch`. Le tour arrive à l'agent sans coordinateur.
- **App** (`companion/intent.ts`) :
  - plus de coordinateur avant l'agent (`dialogueTurn`, `executeCapabilityFirst`) ;
  - plus d'heure ni de date calculées par regex (`phoneDateTime.ts` supprimé) ;
  - plus de routeur de skills local (`buildAutoSkillContextForIntent` n'est plus appelé) ;
  - plus de budget Web ouvert avant le cerveau.
  Le tour admis part au Gateway avec `semanticOwner: "main"`.
- **Claw Live** :
  - `clawLiveDecision(request)` : réflexe social ou cerveau, sans appel au résolveur ;
  - `clawLiveCapability` : exécute la délégation au cerveau ;
  - supprimés : gestes de réalignement, `VoiceUnderstandingState`, Round Learning vocal (`voiceRoundLearning.ts`) et `deterministicLiveDecision` ;
  - `clawLive.ts` : suppression de `clawLiveCapabilityTurn` et de la surface de dialogue ;
  - `voiceBrainDelegation.ts` : `routeVoiceTurnToBrain` remplace `routeUnresolvedVoiceTurn` et `brainTerritory` ;
  - `server.ts` : `/claw-live/decision` et `/claw-live/capability` n'appellent plus `capabilityBridge`.
- **Relais Bixby** (`companion/voiceRelay.ts`) : toutes les demandes et continuations vont au cerveau `main`. Sont supprimés :
  - la surface de dialogue et `resolveDeterministic` ;
  - l'admission déterministe et le rendu des soldes ;
  - la fusion « Précision utilisateur » ;
  - le réalignement.
- **Outil texte libre** : `capabilityTool.ts` (`clawmobile_capability`) est supprimé, et son enregistrement n'existe plus. `capabilityAgentGuard.ts` ne réécrit plus ses arguments. Les outils typés `samantha_*` sont enregistrés sans condition.
- **Interprète dédié** :
  - `intentInterpreterPort.ts` refuse toujours le purpose owner. Seuls le purpose d'ingénierie immune et la pièce Pulse native restent servis ;
  - `model-fast-path.py` ne démarre jamais l'interprète pour un appelant owner, sauf dans la pièce Pulse.
- **MCP** (`mcpBridge.ts`) : la sélection typée (`typed`, `decision.kind = samantha.typed-selection.v1`) n'exige plus le drapeau.
- **Observation des tours WhatsApp natifs** (`nativeTurnProgress.ts`, `nativeTurnProgressOwner.ts`) : elle est toujours active. Le numéro owner de `commands.ownerAllowFrom` reste exigé.
- **Build** : `prepare-lite.mjs` retire de `dist/` les copies périmées de `brainOnly.js`, `capabilityTool.js`, `companion/phoneDateTime.js` et `companion/voiceRoundLearning.js`.

## Ce qui est gardé, et pourquoi

- **Réflexes vocaux sociaux** (`voiceReflex.ts` et sa liste fermée) : décision d'Amine. Gemini Live y répond seul.
- **Pièces des contacts** : la pièce Pulse et les autres pièces gardent leur chemin. Elles relèvent de la PR core #522 (branche `claude/room-brain`) et des étapes suivantes. `test-pulse-room-fast-path.cjs` n'est pas modifié, car cette branche le supprime.
- **Hors périmètre** : `/capability-bridge`, le canal Gemini (`gemini-request.py`, allowlist `clawmobile_capability` de l'agent `gemini`) et la déclaration Gemini Live `clawmobile_capability` côté app. La route correspondante, `/claw-live/capability`, va désormais au cerveau.
- **Manifeste** : `openclaw.plugin.json` déclare encore `clawmobile_capability`. Les listes `deny` des agents contacts et l'allowlist de l'agent `gemini` citent ce nom. Le retirer du manifeste pourrait faire refuser ces configurations au chargement. Ce nom sera retiré avec l'étape 7.
- **Bibliothèque de rendu vocal** (`voiceUnderstanding.ts`) et les fonctions de présentation des reçus : leurs tests propres restent. Les surfaces owner ne les appellent plus, et l'étape 5 (« des faits au lieu de textes ») les traitera.

## Tests

- **Supprimés** : les tests qui ne couvraient que du legacy, à savoir `test-capability-tool`, `test-capability-admission`, `test-run-web-agent`, `test-phone-datetime` et `test-voice-low-risk-admission`. Le module d'adaptation `scripts/lib/legacy-fast-path-as-dialogue.cjs` est supprimé aussi. Leurs étapes sont retirées de `.github/workflows/ci.yml`.
- **Convertis au chemin du cerveau** :
  - pour l'entrée, le guard et les surfaces : `brain-only-entry`, `agent-capability-guard`, `e3-surfaces`, `model-fast-path` ;
  - pour la voix : `voice-option-a`, `voice-brain-delegation`, `voice-relay`, `voice-relay-brain-only`, `voice-understanding`, `request-language-transport`, `run-web-voice` ;
  - pour le mémo vocal : `memo-intent-pipeline`, `memo-deferred-retry`, `memo-p1-http` ;
  - pour les runs, les reçus et l'admission : `edit-replay`, `owner-turn-admission`, `submit-reconciliation`, `n1-factual-failure`, `reason-class-conversation-cause`, `receipt-presentation`, `run-progress`, `run-web`, `typed-failure-presentation` ;
  - pour l'interprète, les outils typés et l'observation : `intent-interpreter-port`, `typed-capability-tools`, `turn-measurement`, `native-turn-observation`, `native-turn-progress`, `generation-interrupt`, `model-flows*` ;
  - pour le MCP apparié : `mcp-read-paired` (C8) et `mcp-context-paired` (C12). Ils prouvent désormais le comportement de production depuis le 28/10 : le texte libre MCP du propriétaire est refusé (`INTERPRETATION_HOST_UNAVAILABLE`) après la réclamation canonique, sans interprétation ni exécuteur.
- **Python** :
  - `test-model-fast-path-intent.py` : les mécanismes du port sont testés avec un appelant non owner, et un nouveau cas vérifie que l'owner ne démarre jamais l'interprète, quelle que soit la variable ;
  - `test-intent-durable-read-paired.py` : le cas de lecture durable de l'app owner via l'interprète est retiré ;
  - `test-runtime-foundations.py` ne cite plus `capabilityTool.ts`.
- **Aucun nouveau test.** Tous les tests modifiés sont déjà inscrits dans la CI.

Exécution locale (conteneur Claude Code, Node 22, Python 3.12) :

- `tsc` est vert ;
- les 196 scripts Node non appariés de la CI passent. `test-catalog.cjs` a échoué une fois sous charge parallèle (`2 !== 3`), puis il passe seul ; il n'est pas touché par ce lot ;
- les tests appariés C8, C12, C16, C18 et `test-intent-durable-read-paired.py` passent avec leurs playbooks épinglés ;
- les tests Python de l'installeur liés à `model-fast-path.py` passent.

La CI canonique (`tools/localci.py`) n'a pas été lancée : la file du conteneur est occupée.

## Déploiement et retour arrière

- **Le déploiement ne dépend plus de la variable.** Aucun script de l'installeur, de `companion-deploy.sh` ni de `runtime-sync.sh` ne la lit ni ne l'écrit. Elle peut rester dans `~/.openclaw/.env` : core l'ignore.
- **À garder pour l'instant :** les playbooks lisent encore `SAMANTHA_BRAIN_ONLY` dans `skill_intelligence/interpretation_gateway.py`, comme garde redondante. Il faut garder `SAMANTHA_BRAIN_ONLY=1` sur le S24 jusqu'à ce que les playbooks retirent cette lecture. Sans la variable, la Gateway core refuse de toute façon le purpose owner.
- **Recette après déploiement :**
  - un tour WhatsApp owner, un tour de l'app et un tour de voix arrivent à `main` sans coordinateur ;
  - un réflexe vocal reste local ;
  - les outils `samantha_*` sont visibles.
- **Retour arrière :** revert de ce commit, puis redéploiement par `installer/termux-lite/companion-deploy.sh <commit précédent>`, qui ramène aussi les copies Gateway et Tier0. Aucune donnée, aucun store et aucune configuration ne sont migrés.
