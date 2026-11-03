# Samantha Voix v2 : attente immédiate, réflexes, avancement rédigé pour Amine, mesures (25/10/2026)

Suite de [voice-brain-delegation-20261025](voice-brain-delegation-20261025.md). Décision d'Amine du 25/10 à 09:44 : « On fait tout, pas de son clavier ; le live avancement m'intéresse beaucoup aussi pour les étapes de progression, et dire dans les instructions que ces live progressions doivent être orientées utilisateur ».

## Constats (S24, 25/10)
- **Silence pendant la réflexion du cerveau.** L'app retient la parole de Gemini tant qu'aucun reçu n'est arrivé, y compris sa phrase d'attente.
- **Le délai vient surtout du démarrage de l'agent.** Mesures dans `trajectory_runtime_events` sur les 6 derniers tours Companion : sans outil, 2,3 à 6,3 s ; avec la relecture de démarrage, 19 à 21 s.
  - À chaque nouvelle conversation, l'agent lance `request_context.py`, puis relit `OPERATING_RULES.md`, `interaction-fast-path.md`, `manifest.json` et `HYBRID_CONTEXT.md`.
  - Les vues bornées de deux de ces fichiers sont pourtant déjà injectées par le Companion.
- **Étapes de progression techniques.** On voyait « Calling exec. », « Completed read. », etc. La carte de progression OpenClaw (`progress_card`) existe, mais une seule carte était stockée, en septembre.

## Changement
- **Attente immédiate** (`clawLiveUnderstanding.ts`, `/claw-live/decision`).
  - Un tour « cerveau » (cadrage modèle seul, `REASON`) devient pris en charge par le Companion : `success: true`, `voiceFastPath {version: 1, execute: true, owner: "samantha_brain"}`.
  - L'app joue alors immédiatement sa phrase d'attente locale (« Je regarde… », déjà enregistrée dans la voix de Samantha) et envoie elle-même le tour à `/claw-live/capability`, donc au cerveau, sans dépendre de l'appel d'outil de Gemini. Le reçu est ensuite lu, mot pour mot s'il fait moins de 600 caractères.
  - Une décision exécutable non déterministe (paiement r11 compris) garde le chemin outil existant, inchangé.
- **Réflexes en liste fermée** (`voiceReflex.ts`, décidés par le code sur la transcription finale).
  - Les réflexes : salutation, remerciement, au revoir, « tu m'entends ? », « attends », « répète », « ça va ? », éventuellement avec le prénom ou « s'il te plaît », seuls ou à deux.
  - `oui`, `non`, `d'accord`, `ok`, un choix ou toute phrase plus longue ne sont jamais des réflexes.
  - Pour un réflexe : `tool_policy: optional`, `voice_policy: reflex`, aucun appel au Graph. Gemini répond seul en une phrase sans fait (contrat `brain delegation v2`).
  - Précédent : la liste versionnée des gestes de réalignement de la voix. Ce n'est pas un routeur de capabilities, car un réflexe n'exécute rien.
- **Avancement rédigé pour Amine.**
  - `runs.ts` `readRunProgressCard` : la carte `progress_card` de la session est lue par le transport Gateway existant (`progressCard.get`).
    - Lecture seulement pour le statut d'une course en cours, avec un cache unique de 1,5 s et un délai de 1,5 s.
    - Une carte antérieure à la course est ignorée. Rien n'est stocké.
  - Ses étapes remplacent les événements d'outils dans les étapes HS5 (`runProgress.ts`), et l'étape en cours devient `progress.text`.
  - La règle de rédaction est dans les instructions canoniques (PR playbooks `user-progress-rule-20261025`). `VOICE_TURN` la rappelle à l'agent pour un tour vocal.
- **Mesures.**
  - `timing {route, coordinatorMs, resolveMs, brainMs}` dans le reçu.
  - Une ligne `[voice-turn] route=… state=… coordinator_ms=… resolve_ms=… brain_ms=… total_ms=…` par tour, dans le journal du Companion. Jamais le texte de la demande ni la réponse.

## Tests
- `test-voice-brain-delegation.cjs` (28 cas) : tour Companion, réflexes (10 positifs, 15 négatifs), paiement r11 inchangé, mesures, ligne de journal, câblage.
- `test-run-progress-card.cjs` (5 cas, nouveau, inscrit en CI), sur la capture S24 réelle de `progressCard.get` : projection, nettoyage, ancienneté, cache unique, étapes HS5, terminal et échec.
- `test-claw-live.cjs` passe au contrat v2.

## Hors de ce lot
- **Lot APK** : relance vers 8–10 s, variantes de la phrase d'attente, arrêt quand Amine reprend la parole, phrase d'avancement dite pendant l'attente (lecture de `progress.text` de la course `voice-cap-<tour>`), relecture vocale d'une réponse différée.
- **Démarrage de l'agent** : supprimer les relectures déjà injectées demande d'étendre les preuves d'injection de `request_context.py` aux blocs du Companion. C'est un contrat de lecture de contexte partagé par toutes les surfaces, qui fera l'objet d'une décision séparée.

## Retour arrière
Revert de ce commit puis `companion-deploy.sh` du commit précédent. Aucun changement d'app.
