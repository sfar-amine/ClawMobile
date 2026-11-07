# Les tours de l'app reçoivent enfin leurs événements d'outil (07/11/2026)

## Constat (recette live sur le S24, 07/11 15:17)
- Tour de l'app « mon solde orange » (`run_1794061009103_21aa04d1`).
- La transcription du moteur montre l'appel `samantha_maxit_tunisie` de 15:17:30 à 15:17:44.
- Le Companion n'a pourtant reçu aucun événement d'outil. L'écran de suivi n'a gardé que « Demande reçue » et « Réponse de Samantha » (69,6 s), et l'indice d'activité de la voix est resté vide.

## Cause
- OpenClaw 2026.10.9 n'envoie les événements d'outil d'un tour qu'aux connexions qui ont déclaré la capacité `tool-events` à la connexion (`resolveAgentTurnRunObserver`).
- La connexion des tours owner du Companion (`ownerTurnGateway.ts`) ne déclarait aucune capacité.
- Les tests passaient parce qu'ils injectent les événements directement dans l'observateur.

## Changement
- `ownerTurnGateway.ts` : la connexion déclare `caps: ["tool-events"]`, une constante fixe (`OWNER_TURN_CAPS`). Aucune autre connexion n'est touchée.
- Fixture `s24-2026-11-07-journey-steps/engine-tool-events-cap.json` : extraits et SHA-256 des modules installés, avec l'observation live.

## Effets attendus
- Les étapes de l'écran de suivi (core#560) apparaissent en direct pour les tours de l'app.
- L'indice d'activité de la voix (« Je regarde tes factures. », 31/10) reçoit enfin l'outil en cours.

## Tests
- `test-owner-turn-admission.cjs` : vérifie que la connexion déclare exactement `["tool-events"]`, et le contrat du moteur d'après la fixture.
- Inchangés et verts : `test-edit-replay`, `test-gateway-run-observation`, `test-run-journey-steps`, `test-generation-interrupt`, `test-voice-waiting-cues`, `test-openclaw-sdk-versions`, `test-companion-runs`.

## Retour arrière
Revenir sur ce commit et redéployer. La connexion redevient sans capacité, et les tours de l'app ne reçoivent plus les événements d'outil.
