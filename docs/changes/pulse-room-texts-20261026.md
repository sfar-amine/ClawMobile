# Pulse room texts — 26 October 2026

Two texts of the Pulse room, worded by Amine:

- A request outside what the room does now gets: « Je n’ai pas compris cette demande Pulse. Précise ce que tu veux créer, modifier ou consulter (projet, offre, phase), ou essaie de la reformuler. » The old text only named phases.
- A leave request is a constraint, not a refusal: « Les demandes de congé ne sont pas prises en compte ici : cette pièce utilise le compte Pulse d’Amine, donc un congé posé ici serait enregistré au nom d’Amine. Pose ta demande de congé directement dans Pulse, avec ton propre compte. » The room agent rules say the same.

Tests: `test-pulse-room-fast-path.cjs` and `test-pulse-room.py` pass. Rollback: revert this commit.
