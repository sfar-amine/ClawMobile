# P1 — Admission native des tours owner (Companion)

L'admission owner de `POST /v1/runs` ne repose plus sur le loopback. Elle exige une preuve ECDSA par requête, signée par une clé Keystore de l'app enrôlée une seule fois par confirmation biométrique (propriétaire canonique des confirmations).

La preuve lie la méthode, le chemin, le corps, le tour, la session, l'horodatage et le nonce. Le Companion refuse les rejeux et les horodatages hors fenêtre.

Seuls les tours admis passent par une connexion Gateway dédiée `operator.admin`, une par tour, méthode `agent` uniquement. Tous les autres restent sur le CLI `operator.write`.

La révocation est signée par l'app, ou faite par l'opérateur en supprimant le fichier d'enrôlement. Un tour déjà remis se termine.

Le drapeau de compatibilité `CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT` est OFF par défaut et ne rend que le contexte canonique. Contrat : `docs/work/samantha-runtime/contracts/p1-admission.md`.

Reprise fichier 46 : `/runs` et les effets de `/claw-live/capability` utilisent désormais un ticket opaque courant, jamais une valeur owner constante. Ciblés locaux verts : admission 64/64, voix HS3 21/21, E3 44 contrôles, édition/relecture et build. Le Gateway public isolé confirme cinq cas, avec jeton/configuration/état jetables détruits ; fixture locale distincte des captures S24.

Publication bloquée : absence de callback public de revérification pendant bootstrap/handshake avant ACK, et annulation app non qualifiée. Révocation après ACK laisse terminer le tour accepté ; seul `chat.abort` admin a fermé sa garde avant effet. Demande technique à Claude : core #182 commentaire 6110445351, contrat PB #100 commentaire 6110445569. Aucune CI verte ne vaut déploiement ni levée de cette limite.

Le complément `84b8a0ed` revérifie l’admission avant un nouvel effet de learning après `await execute`. Si elle n’est plus courante, le reçu de l’effet déjà accepté est conservé et le learning est omis (`skipped`, `owner_admission_expired`), avec zéro capture. La recette `197221f7` vérifie le refus capability voice sans signature.
