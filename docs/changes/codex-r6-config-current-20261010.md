# R6 — configuration main avec révision et reçu

Projection de modèle, replis, réflexion et politiques d’outils ; patch limité aux réglages de modèle validés par le propriétaire Gateway. Contrat : docs/work/samantha-runtime/contracts/r6.md.

Garde paiement/confirmation, validation avant réservation, readback après effet, aucun redispatch incertain. Tests ciblés et toutes les commandes CI sur base 6d69680. CI inchangée pendant R2-v2 #3 ; qualification et activation par Claude.


Relecture Claude : suffixes @profile conservés, catalogue filtré par allow-policy, disponibilité runtime/plugin et models.authStatus, niveaux par modèle. CAS et failed prédispatch séparés de l’incertitude ; confirmation liée pour l’ajout d’un fournisseur/profil de repli. Base runtime 639ae68 intégrée par merge ; test R6 inscrit sans retirer aucune étape CI. Compatibilité réelle RPC OpenClaw 2026.9.6 et biométrie S24 à qualifier par Claude, aucun déploiement Codex.
