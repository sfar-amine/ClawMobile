# 38 E3 — Surfaces et agent

Reprise par Claude de la préparation de Codex (#136) après fusion et déploiement de P1 (#107). Base `runtime/samantha-companion-private` intégrée par merge (union CI).

- L'agent libre ne lance plus de capability opérateur ni transaction : `clawmobile_capability` passe par `claw-capability.py agent-execute` (une résolution canonique, politique E3, exécution `--read-only` de la décision exacte), sinon `capability_first_required` sans exécution.
- Hook `before_tool_call` enregistré : `caller` pris du tour, arguments malformés refusés ; suivi providerFallback conservé.
- WhatsApp, relais voix et Gemini Live suivent le contrat CLARIFY de l'app (`resolve-clarification`, texte original, aucune concaténation) ; Gemini Live transmet la transcription d'entrée et un `clarificationId`.

Contrat : `docs/work/samantha-runtime/contracts/38-e3.md`. Parcours de paiement intouché. Recette T5 réelle sur le S24 après déploiement.
