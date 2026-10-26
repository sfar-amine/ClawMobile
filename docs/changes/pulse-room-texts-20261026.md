# Pulse room texts — 26 October 2026

Two texts of the Pulse room, worded by Amine:

- A request outside what the room does now gets: « Je n’ai pas compris ta demande Pulse. Peux-tu préciser, stp, ce que tu veux créer, modifier ou consulter (projet, offre, phase) ? Tu peux aussi essayer de la reformuler. Merci ! » The old text only named phases.
- A leave request is a constraint, not a refusal: « Désolé, je ne peux pas prendre en compte les demandes de congé : j’utilise le compte Pulse d’Amine, donc un congé posé ici serait enregistré au nom d’Amine. Merci de poser ta demande de congé directement dans Pulse, avec ton propre compte. » The room agent rules say the same, without the word « pièce », which a contact would not understand.

Tests: `test-pulse-room-fast-path.cjs` and `test-pulse-room.py` pass. Rollback: revert this commit.
