# P1 — Admission native des tours owner (Companion)

L'admission owner de `POST /v1/runs` ne repose plus sur le loopback. Elle exige une preuve ECDSA par requête, signée par une clé Keystore de l'app enrôlée une seule fois par confirmation biométrique (propriétaire canonique des confirmations).

La preuve lie la méthode, le chemin, le corps, le tour, la session, l'horodatage et le nonce. Le Companion refuse les rejeux et les horodatages hors fenêtre.

Seuls les tours admis passent par une connexion Gateway dédiée `operator.admin`, une par tour, méthode `agent` uniquement. Tous les autres restent sur le CLI `operator.write`.

La révocation est signée par l'app, ou faite par l'opérateur en supprimant le fichier d'enrôlement. Un tour déjà remis se termine.

Le drapeau de compatibilité `CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT` est OFF par défaut et ne rend que le contexte canonique. Contrat : `docs/work/samantha-runtime/contracts/p1-admission.md`.

Reprise fichier 46 : `/runs` et les effets de `/claw-live/capability` utilisent désormais un ticket opaque courant, jamais une valeur owner constante. Ciblés locaux verts : admission 73/73, voix HS3 21/21, E3 44 contrôles, édition/relecture et build. Le Gateway public isolé confirme six cas, avec jeton/configuration/état jetables détruits ; fixture locale distincte des captures S24.

Le client public GatewayClient revalide le ticket après résolution de configuration/SecretRef et, après HELLO, immédiatement avant request synchrone. Les scopes effectivement accordés et la méthode agent sont vérifiés. Une seule connexion et un seul envoi, puis fermeture canonique. Remote/TLS/URL overrides et SecretRef irrésolu sont refusés, sans repli CLI d’un tour initialement admis. Après émission, le résultat est indéterminé jusqu’à réception : aucun second envoi ni repli. Après acceptation, l’effet peut se terminer malgré révocation ; reçu conservé. Aucune annulation app n’est livrée. La CI entière doit encore être rejouée au SHA final avant publication ; les commentaires 6110445351/6110445569 décrivent le blocage antérieur maintenant corrigé localement.

Le complément `84b8a0ed` revérifie l’admission avant un nouvel effet de learning après `await execute`. Si elle n’est plus courante, le reçu de l’effet déjà accepté est conservé et le learning est omis (`skipped`, `owner_admission_expired`), avec zéro capture. La recette `197221f7` vérifie le refus capability voice sans signature.

F6 : le premier passage entier `40965914` est conservé à 82/83, seul F6 rouge. Le correctif isolé `dc5cc696` garde un inventaire `/proc` dépassant 4096 indéterminé sans scanner une liste tronquée. Build et cible réelle sous EX : 17 abandons, 442 ms, `procOverflowUnknown:true`, sortie0 (`b46-p1-f6-overflow-targeted.log`). Aucun budget ni assertion abaissé. Les cmdline illisibles et le cache de cinq secondes restent des limites préexistantes. La base runtime fraîche `f5d8a6d7` est intégrée normalement, avec union de la CI et le test Maxit hérité inchangé. Une nouvelle entière au SHA final est requise.
