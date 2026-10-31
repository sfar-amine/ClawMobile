# Voix : lecture du run du cerveau en mémoire, toutes les 100 ms — 31 octobre 2026

Banc voix du 31/10 sur le S24 (brain-only). Un tour sans outil coûte 6,2 s de t25 à t30, pour une étape de modèle d'environ 3 s.

## Coût fixe évitable, corrigé ici

Le tour vocal attend le run du cerveau par `delegateVoiceTurnToBrain`. Il interroge `getRunStatus` toutes les `VOICE_BRAIN_POLL_MS` = 500 ms.
- **Attente.** Une réponse arrivée attend en moyenne 250 ms (0 à 500) avant d'être lue.
- **Lectures du registre.** Chaque lecture relit et parse `runs.json` plusieurs fois, sur la boucle d'événements qui relaie aussi l'audio Gemini Live. Le test mesure 28 lectures du fichier pour un tour de 6,2 s.

Changement :
- `voiceRunStatus` (`runs.ts`) répond depuis la mémoire tant que ce processus suit le socket Gateway du run et que le run n'est pas terminal. C'est la même ligne mémoire que `observedRunStatus`.
- Tout autre cas passe par `getRunStatus`, inchangé : terminal, réconciliation, observation expirée, run inconnu.
- La route `/claw-live/capability` lui passe `pollMs: 100`.
- `voiceBrainDelegation.ts` n'est pas modifié.

**Gain** : environ 200 ms en moyenne par tour vocal du cerveau, jusqu'à 400 ms. Plus aucune lecture de `runs.json` pendant que le cerveau travaille : 4 lectures au lieu de 28 à 110 par tour, selon la durée.

## Autres coûts fixes repérés (non corrigés : pas petits ou pas sûrs sans mesure S24)

La ligne `[voice-stages]` de la PR permet de les chiffrer au prochain banc.

1. **Deux écritures complètes du registre avant la requête Gateway.**
   - `reserveSubmittedRun` (`runs.ts`), puis `observeGatewayRun` (`intent.ts:426` → `updateObservedRun`), réécrivent chacune `runs.json` entier avant `submitOwnerTurn`.
   - Le coût grandit avec le registre (capture S24 du 26/10 : 13,9 s entre le terminal et `updatedAt`).
   - Mesure : `sent_ms - accepted_ms`.
2. **Contexte propriétaire reconstruit à chaque tour par un processus Python synchrone.**
   - Avec `SAMANTHA_CONTEXT_FOUNDATION=1`, `compactOwnerAgentContext` (`openclawAgentClient.ts:67` → `ownerFoundationParts`) lance `execFileSync('python3', context_foundation.py)` (`ownerBootstrapContext.ts:16`, délai max 1,5 s). Cela bloque la boucle du Companion, relais audio compris.
   - Le crochet Gateway `ownerFoundationHook` (`before_prompt_build`) relance le même producteur pour la mémoire, dans le processus Gateway.
   - Coût : un démarrage de python3 par processus et par tour (environ 130 ms au p50 sur le S24 selon la qualification télémétrie du 09/10), plus le travail du producteur.
   - Correctif possible, par le propriétaire existant : mémoïser la partie stable par empreinte du producteur et des fichiers sources.
   - Mesure : `sent_ms - accepted_ms`, et `run_start_ms - sent_ms` côté Gateway.
3. **Historique vocal ajouté au message à chaque tour.**
   - `appendVoiceConversationContext` (`intent.ts:191`, `runs.ts`) relit tout le registre et préfixe jusqu'à 40 échanges vocaux au message du cerveau.
   - En mode brain-only, ces échanges sont déjà dans la session du cerveau. Le message utilisateur grossit donc à chaque tour d'une même conversation vocale (jetons non cachés en plus). Sans effet sur un banc à session neuve.
4. **Préparation Gateway avant le premier appel modèle.**
   - Environ 9 s le 30/10 (préflight 4,3 s, catalogue Tool Search puis streamFn 3,3 s) ; 21,8 s sur la capture vocale du 25/10. Tâche existante « démarrage à froid ».
   - Mesure : `run_start_ms - sent_ms`, puis `first_text_ms - run_start_ms`.
5. **Pas d'appel d'interprétation avant le cerveau en mode brain-only.** `clawLiveDecision` (`clawLiveUnderstanding.ts:115`) ne fait que le test des réflexes, et `routeUnresolvedVoiceTurn` met `resolveMs: 0`. Aucun coût fixe de ce côté.

## Test

`scripts/test-voice-run-poll.cjs` couvre les points suivants :
- 50 lectures vocales d'un run suivi : aucune lecture de `runs.json` ;
- terminal, inconnu et expiré passent par le chemin complet, avec le texte vérifié ;
- trois tours réglés aux instants des runs réels du S24 : 12 846 ms (26/10), 26 563 ms (25/10) et 6 230 ms. L'attente après la réponse passe de 154, 437 et 270 ms à 54, 37 et 70 ms, et les lectures du registre de 54, 110 et 28 à 4 ;
- la route vocale utilise ce statut et ce pas.

## Retour arrière

Revert du commit : retour à `getRunStatus` toutes les 500 ms.
