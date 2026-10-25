# ADR-20261025 — Samantha Voix : Gemini Live délègue tout au cerveau

- Statut : accepté (décision d'Amine, 25/10/2026, « il doit absolument tout déléguer au cerveau »)
- Portée : surface vocale Android (`client=samantha_android`) du Companion

## Contexte
Gemini Live servait à la fois d'interface vocale et de second cerveau. Il pouvait répondre seul aux phrases que le Graph classait « conversation ». Pour cela, il recevait le harnais complet de l'agent texte (règles d'exploitation, vue mémoire, décisions vocales), sans aucun moyen de l'appliquer.

Résultat mesuré le 24/10 : 24 tours vocaux sur 30 n'ont pas atteint Samantha, avec des affirmations inventées.

## Décision
1. Gemini Live est l'oreille et la bouche. Tout tour d'Amine va au cerveau (`ask_samantha`). Gemini ne répond jamais seul.
2. Le contrat vocal ne contient que ce que Gemini peut tenir : l'identité, la manière de parler, les règles de lecture des reçus et l'interdiction de prétendre à un effet sans le texte retourné. Les règles, la mémoire et les décisions restent chez l'agent principal, qui reçoit en plus le contexte vocal canonique.
3. Hors route déterministe, la décision vocale est toujours « preuve requise ». L'app ne libère donc que la parole fondée sur un reçu Samantha.
4. Le secours (aucun outil appelé) passe par le coordinateur de dialogue, qui reste le seul propriétaire de la question en attente. Pour ce qu'il laisse non résolu :
   - une décision Graph exécutable, de clarification ou d'arrêt garde son exécuteur existant (paiement compris) ;
   - un cadrage « modèle seul » va à l'agent principal par le même propriétaire que `ask_samantha` (soumission de run, registre), et plus jamais à une exécution Graph d'une phrase de conversation.

## Conséquences
- Parité chat/voix : une phrase dite suit le même chemin qu'une phrase écrite (coordinateur, capacité d'abord, agent principal).
- Plus de latence (modèle de l'agent principal) et plus de consommation du quota ChatGPT inclus.
- Aucun nouveau composant, store, routeur ou retry. Les propriétaires existants sont réutilisés.
- Les routes déterministes (lectures opérateur, date et heure, réalignement) sont inchangées.

## Révision v2 (25/10/2026, 09:44, décision d'Amine « On fait tout »)
- **Réflexes.** Une liste fermée, décidée par le code (`voiceReflex.ts`), est la seule exception à « tout déléguer » : salutation, remerciement, au revoir, présence, attente, répétition, « ça va ». Ces réflexes ne portent aucun fait et n'exécutent rien. Une réponse à une question, un choix, `oui`/`non`/`d'accord` vont toujours au cerveau.
- **Attente.** Un tour cerveau est pris en charge par le Companion (`voiceFastPath`). L'app joue tout de suite sa phrase d'attente locale et le tour atteint le cerveau, quoi que fasse le modèle vocal.
- **Avancement.** Les étapes et la phrase en cours viennent de la carte de progression de l'agent (`progress_card`, propriétaire OpenClaw existant), écrite pour Amine selon la règle canonique des playbooks.

## Retour arrière
Revert du commit, puis redéploiement du Companion par `companion-deploy.sh`. L'app n'est pas modifiée.
