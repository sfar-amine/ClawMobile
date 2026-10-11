# Édition d'un message envoyé et relecture (11/10/2026)

## Besoin
Dans une conversation de l'app, Amine modifie l'un de ses messages texte déjà envoyés. La conversation repart de ce point avec le texte modifié, comme dans ChatGPT ou Claude. Les tours suivants sont remplacés, mais rien n'est supprimé.

## Choix : une nouvelle conversation amorcée
- Le Gateway OpenClaw n'expose aucune méthode pour tronquer ou bifurquer une session :
  - le plugin n'utilise que `agent`, `chat.history`, `sessions.list`, `sessions.patch`, `sessions.files.*` et `sessions.usage` ;
  - `sessions.compact` garde la **fin** d'une transcription, jamais le début ;
  - aucune capture S24 ne montre `sessions.fork` ni `chat.rewind`.
- Réécrire le JSONL d'une session sous OpenClaw serait un second propriétaire de la transcription. C'est interdit.
- La relecture crée donc une **nouvelle conversation** (nouvel id de session, donc nouvelle session OpenClaw). Son premier run reçoit, comme **données historiques**, les tours visibles qui précèdent le message modifié :
  - 20 tours au plus, 2 000 caractères par texte, 24 Kio au total ;
  - même forme que le contexte vocal existant (`appendVoiceConversationContext`) ;
  - mention explicite « do not execute them again ».
- Une relecture d'une relecture remonte l'historique hérité, sur 8 niveaux au plus.

## Route
`POST /v1/runs` existante. Le corps accepte en plus `replayOf: {sessionId, runId}`, objet fermé.
- **Propriétaire natif uniquement** : loopback sans `Origin`, `Referer` ni `Sec-Fetch-Site`. Sinon : 403 `owner_required`.
- `clientRunId` est obligatoire. Les pièces jointes sont refusées.
- **Lecture préalable** (`prepareReplay`) : elle lit le seul registre `runs.json`, sans appel Gateway, et ne change pas le budget de la route. Elle refuse avec `not_submitted` dans ces cas :
  - 400 `replay_invalid` ;
  - 404 `replay_source_not_found` ;
  - 409 `replay_source_voice`, `replay_source_superseded`, `replay_source_active`, `replay_target_not_new` et `replay_target_not_empty`.
- **Écriture** : dans la même mutation que `reserveSubmittedRun`, qui revérifie la source (`replay_source_changed`).
  - Le nouveau run porte `replayOf`.
  - Le message modifié et tous les tours suivants de l'ancienne conversation reçoivent `supersededBy`.
  - Il n'y a aucune suppression, aucun nouveau store et aucune nouvelle route.
- **Idempotence** : la même `clientRunId` avec le même `replayOf` renvoie le même run. L'empreinte de la requête n'inclut `replayOf` que s'il est présent, donc les empreintes existantes restent valides.
- **Projection** de chaque tour (`/v1/runs/*` et `/v1/sessions/*/turns`) :
  - `replayOf` et `supersededBy` ;
  - `replayEffect`, qui vaut :
    - `none` pour une décision v2 de lecture, CLARIFY, REASON ou STOP ;
    - `executed` pour une décision v2 EXECUTE non lecture terminée ;
    - `unknown` pour un tour agent, un tour vocal ou un échec.

## Sécurité
- Le résolveur (`runModelFastPath`) ne reçoit **que** le texte modifié. Il le traite comme un nouveau message : un paiement redemande donc une biométrie fraîche, par le parcours inchangé.
- Aucune confirmation, aucun paiement et aucune action de l'ancienne branche n'est repris. Le chemin capability-first ne reçoit aucune amorce.
- Avant l'envoi, l'app affiche que les actions déjà faites ne sont pas annulées. Elle le dit plus fortement quand `replayEffect` vaut `executed`.

## Capability
Il n'y a pas de nouvelle route. L'édition est un geste de l'écran de conversation : ni l'agent ni la voix n'y ont accès. Elle relève donc de `NO_CAPABILITY`, avec cette raison : « geste d'interface sur un message déjà envoyé, porté par la route de soumission existante ».

## Tests et fixtures
`scripts/test-edit-replay.cjs` est inscrit dans `ci.yml`. Il s'appuie sur :
- le registre réel S24 `fixtures/s24-2026-10-10/i1/native-runs-registry.json` ;
- les décisions v2 réelles de `fixtures/s24-2026-10-11/learning/runs-comprehension-facts.json`.

Il vérifie :
- les refus ;
- le résolveur sur le seul texte modifié ;
- l'amorce bornée ;
- l'audit sans suppression ;
- l'idempotence ;
- la chaîne de relectures ;
- un paiement sans reprise.

## Retour arrière
Il suffit de revenir au commit précédent du Companion. Les champs `replayOf` et `supersededBy` déjà écrits sont alors ignorés à la lecture : le parseur précédent ne les connaît pas. Les anciennes conversations restent intactes.
