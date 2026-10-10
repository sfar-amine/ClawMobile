# P2-f-companion — livraison locale

Expose owner laptop pairing and revocation with single use signed confirmation scopes

Validation : Build/full CI_LOCAL_OK; default fixture and real paired controller tests verify P-256 signatures, payment isolation, durable replay and native HTTP boundaries.

Branche isolée préparée pour PR ; Claude relit, fusionne, active et recette. Aucun merge ni déploiement par Codex. Retour arrière : revert du commit de ce lot.

Relecture 17 : All runtime CI commands passed; signed confirmation isolation and replay preserved, 4-second mutation succeeds, slow read is stopped within its 3.5-second budget. Delta poussé pour relecture ; aucune fusion ni activation.
