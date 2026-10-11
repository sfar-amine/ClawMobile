# O10 (core) — la voix exécute la décision vocale du propriétaire

Jumelle core de playbooks O10 (`samantha.voice.decision.record`, décision d'Amine du 10/10 : risque faible, sans
biométrie ni confirmation).

- `voiceRelay.ts` : `deterministicVoiceAdmission` exécute directement une capability résolue si elle est
  déterministe, sans confirmation (`resolved` et `selected`) et de risque registre `read` ou `low`. `low` n'est porté
  que par la décision vocale. Tout autre risque, tout paiement et tout chemin confirmé continuent vers le tour d'agent.
- `extractFastClarification` transmet la question d'un résultat `needs_parameter` (« Quelle décision veux-tu que je
  note ? ») ; la réponse revient par `composeContinuationRequest`, que l'adaptateur playbooks comprend.
- Aucune route, capability ou recette nouvelle : `companion-acceptance.py` sans objet. Parcours de paiement intact.

Test (CI) : `scripts/test-voice-low-risk-admission.cjs` (résolution Orange capturée sur le S24 et sortie du Graph pour
la décision vocale). Recette live : Claude, à la voix, après activation des deux PR. Retour arrière : revert.
