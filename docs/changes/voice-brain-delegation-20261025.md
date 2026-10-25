# Samantha Voix délègue tout au cerveau (25/10/2026)

## Problème
Rounds vocaux d'Amine du 24/10 au soir, analysés sur le S24 (`runs.json`, `dialogue.sqlite`) : seuls 6 tours sur 30 ont atteint le coordinateur de dialogue. Gemini Live a répondu seul au reste, sans contexte réel. Cela a produit :
- des affirmations inventées : « ajustements récents », « c'est mémorisé » ;
- un refus « confidentiel » opposé au propriétaire ;
- des codes internes lus à voix haute.

Causes établies dans le code et sur le S24 :
- **La consigne vocale laissait une porte de sortie** : « Pure conversation, explanation, identity and creative requests may be answered directly ». Le Graph classe ces phrases `REASON` / `tool_policy: optional` (capture réelle : « Qu'est-ce que tu as ajusté récemment ? » donne `model_only_framing`, confiance 0,46). L'app libère alors la réponse propre de Gemini.
- **Gemini recevait le harnais de l'agent texte, qu'il ne peut pas exécuter** :
  - lancer `request_context.py` ;
  - lire les `required_reads`, les `SKILL.md` et les événements sources ;
  - sauvegarder immédiatement et faire un checkpoint toutes les 5 minutes ;
  - reprendre les fils de la session vocale précédente.

  Il n'a ni shell, ni fichier, ni écriture mémoire. Il simulait donc ces devoirs.
- **Secours mal dirigé** : un tour que le coordinateur laisse non résolu repartait vers une seconde exécution Graph (`capabilityBridge execute`) d'une phrase de conversation. C'est ce chemin qui a lancé une action `device.assistance` à 0,46.

## Décision
Décision d'Amine du 25/10 : « il doit absolument tout déléguer au cerveau ». Gemini Live devient les oreilles et la bouche de Samantha. Son cerveau, l'agent principal, répond à tout. Voir [ADR-20261025-voice-brain-delegation](../08-decisions/ADR-20261025-voice-brain-delegation.md).

## Changement
- **`clawLive.ts`, client `samantha_android`** (contrat `brain delegation v1`) :
  - Règle absolue : chaque tour d'Amine va à `ask_samantha`, mot pour mot. Gemini ne répond jamais de lui-même, ni de l'historique, ni des consignes. Il ne prétend jamais avoir noté, fait ou vérifié quoi que ce soit sans le texte retourné. Il ne s'abrite jamais derrière la confidentialité face au propriétaire.
  - Outils : `ask_samantha` d'abord. `clawmobile_capability` est réservé à la réponse à une question `needs_clarification` d'un reçu Claw, avec `clarificationId` obligatoire.
  - Contexte : seulement `SOUL.md` et la section « Interaction vocale » de `memory/voice/amine.md` (`voiceStyleView`). Plus d'`OPERATING_RULES`, de `HYBRID_CONTEXT`, ni de décisions ou d'historique vocaux. Le prompt passe d'environ 33 Ko à moins de 16 Ko.
  - Les autres clients (page navigateur) gardent le contrat historique, inchangé.
- **`clawLiveUnderstanding.ts`, `/claw-live/decision`** :
  - Hors route déterministe, la politique devient `tool_policy: required`, avec `voice_policy: brain_delegation`. La politique d'origine du Graph reste visible dans `model_tool_policy`. L'app ne libère donc plus l'audio de Gemini sans reçu Samantha.
  - Inchangés : la route déterministe, le geste de réalignement et la date/heure du téléphone.
  - `clawLiveCapability` ne réécrit plus un reçu du cerveau avec le gabarit des capacités (« J'ai compris… », « Ça n'a pas abouti… »).
- **`voiceBrainDelegation.ts` et `server.ts`, `/claw-live/capability`** : pour un tour que le coordinateur laisse non résolu (`continue`), une résolution en lecture seule (5 s) décide de la suite.
  - Une décision exécutable, de clarification ou d'arrêt garde l'exécuteur Graph existant, inchangé. Le parcours de paiement est inclus (capture réelle r11 `payment.owner_native`), de même qu'un résolveur indisponible.
  - Seul un cadrage « modèle seul » (`REASON`, ou aucune décision avec `tool_policy: optional`) est délégué au cerveau, par le propriétaire existant de `ask_samantha` : `submitIntent` avec `voiceDelegation` et le registre des runs.
    - même ticket d'admission, même `clientRunId` ;
    - attente bornée à 30 s, comme `DELEGATION_BUDGET_MS` côté app ;
    - au-delà, « Je te l'écris dans la discussion. » ;
    - issue inconnue : jamais de relance ni de succès annoncé ;
    - échec : phrase lisible, le détail technique reste dans la discussion.

  Aucun store, file, retry ni route parallèle.
- **`compactOwnerAgentContext`, tour vocal délégué** : l'agent reçoit, à la suite du contexte canonique inchangé, `VOICE_TURN` (le tour vient de la voix et sera lu tel quel) et `VOICE_CONTEXT` (le fichier vocal canonique, borné à 7 000 caractères). Les règles restent à leur place canonique.

## Tests
- `scripts/test-voice-brain-delegation.cjs` (24 cas, inscrit dans `ci.yml`), sur captures S24 réelles `fixtures/s24-2026-10-25-voice-brain` (SOUL, fichier vocal et règles, avec sha256, et résolutions `claw_live`) et sur la capture de paiement r11 :
  - contrat Gemini ;
  - absences dans le prompt ;
  - décision, fermée par défaut ;
  - aiguillage du non-résolu : le modèle seul va au cerveau ; le paiement, l'exécutable, la clarification, l'arrêt et le résolveur indisponible restent sur l'exécuteur ;
  - délégation au cerveau : terminé, en attente, refusé, inconnu, admission expirée, échec, texte long ;
  - non-réécriture du reçu ;
  - contexte de l'agent ;
  - câblage.
- Non-régression des tests voix existants : `test-voice-option-a`, `test-voice-operating-rules`, `test-voice-understanding`, `test-voice-choices`, `test-e3-surfaces`, `test-voice-turn-protocol`, `test-canonical-agent-bootstrap`.

## Limites connues
- **Silence pendant l'attente du cerveau.** L'app coupe la phrase d'attente de Gemini à l'appel d'outil. L'attente est donc silencieuse, avec l'état « traitement » à l'écran. Un clip d'attente pour `ask_samantha` demande un lot APK.
- **Pas de relecture différée sur le chemin de secours.** Si le cerveau dépasse 30 s, la réponse arrive dans la discussion sans être relue à voix haute. La relecture différée existe déjà via `ask_samantha`.
- **Quota.** Chaque tour vocal consomme désormais l'usage ChatGPT de l'agent principal (vitesse prioritaire active).
- **Hors portée** : le classement Graph de « Bonjour Samantha » en `samantha.app.catalog` (0,94).

## Activation
Déploiement du Companion par `companion-deploy.sh` (aucun changement d'app), puis recette vocale d'Amine. Retour arrière : revert de ce commit puis redéploiement.
