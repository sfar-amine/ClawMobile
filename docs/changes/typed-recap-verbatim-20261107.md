# Outils typés : un récapitulatif à confirmer reste mot pour mot (07/11/2026)

Le 07/11 à 23:00, le déploiement de 87823c1e (#569, marge du cerveau sur la réponse prête) est revenu en arrière automatiquement : le parcours de recette `write_recap` a échoué.

Pour « Ajoute à mon agenda demain à 10h un rendez-vous intitulé Recette déploiement », l'outil a rendu le récapitulatif « Confirme cette action : … Confirmer ? ». Le cerveau l'a reformulé avec ses propres mots : « Je vais ajouter ce rendez-vous à ton agenda Google : … Tu confirmes ? ». Il s'est bien arrêté avant l'écriture. Mais ce que tu confirmes doit rester le reçu lui-même.

La marge reste sur les résultats. La description dit maintenant : « Pars de la réponse prête du reçu sans inventer de fait ; si elle est générique ou contredit ses faits (facts), réponds depuis ces faits et signale l'écart ; un récapitulatif à confirmer et une question du reçu restent mot pour mot, sans format, exemple ni consigne ajoutés. »

Cette formulation plus courte garde la surface des outils typés sous son budget de 34 000 caractères (33 677 mesurés). La première version de cette PR en mesurait 34 645 et faisait échouer l'étape 124 de la CI.

Preuve réelle : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-07-typed-generic-answer/rollback-write-recap.json`.
