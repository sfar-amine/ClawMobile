# Voix option A : parcours canonique avant le choix d'outil

La transcription finale déclenche les EXECUTE déterministes sans raisonnement, puis Gemini lit le reçu. `ask_samantha` délègue la demande originale à `main` dans la même discussion, uniquement sous admission P1 signée et courante. Le duplex accueille en premier sur une génération corrélée, sans outil possible. Aucun module paiement n'est modifié.

Ciblés locaux sous verrou exclusif : compilation TypeScript ; 13 cas option A ; 16 cas protocole ; rapport P1 58 cas ; 20 cas présentation voix HS3 ; bootstrap Claw Live. Tests inscrits dans la CI existante. La disponibilité à fusionner est conditionnée à la suite entière verte au SHA final, preuve dans la PR, et à la dépendance P1. Recette S24 et 20 phrases restent explicitement non qualifiées : [demande Claude](https://github.com/sfar-amine/samantha-core/pull/182#issuecomment-6110135476).

Contrat : `docs/work/samantha-runtime/contracts/voice-option-a.md`. Capture réelle réutilisée sans transformation : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/o7-o8-orange-20261010-0941.json`. Aucun nouveau store, scheduler ou route HTTP. Retour arrière : revert de V, sans migration.
