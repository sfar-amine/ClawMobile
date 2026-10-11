# E3 / R20 lot 2 — modifier un fichier de l'agent

`PUT /v1/files/content?scope=agent&path=NOM` (garde owner) écrit `AGENTS.md`, `SOUL.md`, `USER.md` ou `IDENTITY.md` via `agents.files.set`. [Contrat](../work/samantha-runtime/contracts/e3.md).

- Biométrie `agent.file_write` : référence = nom, `payloadHash = sha256(contenu envoyé)` ; sans confirmation, 403 `needs_confirmation`.
- CAS : `baseHash` = `revision` de la lecture (sha256 du propriétaire), précontrôle puis `expectedHash` natif.
- Garde des instructions de paiement et des secrets, que la Gateway n'a pas : chaque ligne `[masqué]` est restituée telle quelle, aucune ne peut être retirée, ajoutée ou modifiée, et aucune nouvelle ligne paiement ou secret n'est acceptée.
- Sauvegarde de la version remplacée, que la Gateway ne fait pas : `<NOM>.bak-samantha-<horodatage>` dans le workspace (0600), 5 au plus par fichier.
- Reçu natif, une seule écriture, une relecture après effet incertain, jamais de rejeu. Ni suppression ni renommage.
