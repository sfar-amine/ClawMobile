# HS3 — première cause du paiement lié

La projection publique distingue maintenant la première execution_error propriétaire de l'état aval du paiement. Les codes publics et horodatages validés sont projetés sans trace brute ; le lecteur ferme toute métadonnée inconnue. La comparaison `runUpdatedBeforePaymentCreated` reflète les dates existantes et n'invente aucune date de fin. Le run et le paiement restent intacts, et aucune preuve de débit n'est déduite de ces champs.

Source réelle : capture184 `07be0bbb…`, byte-identique, complétant176. Contrat `docs/work/samantha-runtime/contracts/hs3-initial-failure-20261011.md`. Nouveau test ajouté à la même étape CI que la présentation existante ; ciblés Node20 verts : capture184 HTTP immuable, présentation176 (2 chaînes, maxReadMs30) et voix20/20. Suite entière finale en attente. Correctif F6 portable dc5cc696 repris pour ne pas réintroduire son erreur de liveness dans la base7c5.

Correction partagée R20a947 reprise également sur la base7c pour fermer la course de terminaison observée dans K2, sans changer le paiement. Ciblés de l’union build/projection184/présentation176 (maxReadMs21)/strictcleanup9/9 verts ; F6 ciblé17abandons/sweep467ms/overflowunknown vert. Journaux `hs3-46-r20-union-targeted.log` et `hs3-46-f6-targeted.log`. Toute la CI finale reste en attente au SHA gelé.

Base runtime actualisée par fusion normale `f5d8a6d7b327d3a3769b9b04bf97174084ea6e6c` (#191) : capture nettoyée du devis Maxit et nouveau test CI conservés, aucun propriétaire paiement modifié. Ciblés sous EX : build Node20 + devis réel 3/3 dans les deux worktrees ; projection HS3 HTTP/presentation176 également verte (maxReadMs19). Journal `hs8-hs3-base191-targeted.log`, exit0. Suite entière finale au nouveau SHA reste en attente.
