# K2 — décision propriétaire, sans rappel

La décision d’Amine du 11/10, [reportée par Claude dans core #119](https://github.com/sfar-amine/samantha-core/pull/119#issuecomment-6108204935), remplace la proposition de rappel : message au propriétaire à chaque changement effectif d’accès temporaire accordé/prolongé/retiré/expiré. Prolongation biométrique R17 existante, durées 1/3/5 non tranchées, choix R17 actuels conservés.

Contrat uniquement. Livraison/canal/reçu et déduplication (contact, changement) restent à capturer sur S24 avant code ; gate bloqué sur ces sources, pas sur la décision désormais connue. Aucun nouveau store/timer, mutation ou envoi. CI complète locale non rejouée sur cette tête.
