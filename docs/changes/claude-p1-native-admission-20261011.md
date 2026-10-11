# P1 — Admission native des tours owner (Companion)

L'admission owner de `POST /v1/runs` ne repose plus sur le loopback. Elle exige une preuve ECDSA par requête, signée par une clé Keystore de l'app enrôlée une seule fois par confirmation biométrique (propriétaire canonique des confirmations).

La preuve lie la méthode, le chemin, le corps, le tour, la session, l'horodatage et le nonce. Le Companion refuse les rejeux et les horodatages hors fenêtre.

Seuls les tours admis passent par une connexion Gateway dédiée `operator.admin`, une par tour, méthode `agent` uniquement. Tous les autres restent sur le CLI `operator.write`.

La révocation est signée par l'app, ou faite par l'opérateur en supprimant le fichier d'enrôlement. Un tour déjà remis se termine.

Le drapeau de compatibilité `CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT` est OFF par défaut et ne rend que le contexte canonique. Contrat : `docs/work/samantha-runtime/contracts/p1-admission.md`.
