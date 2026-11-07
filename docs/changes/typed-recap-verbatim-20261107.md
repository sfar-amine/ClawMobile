# Outils typés : un récapitulatif à confirmer reste mot pour mot (07/11/2026)

Le 07/11 à 23:00, le déploiement de 87823c1e (#569, marge du cerveau sur la réponse prête) est revenu en arrière automatiquement : le parcours de recette `write_recap` a échoué.

Pour « Ajoute à mon agenda demain à 10h un rendez-vous intitulé Recette déploiement », l'outil a rendu le récapitulatif « Confirme cette action : … Confirmer ? ». Le cerveau l'a reformulé avec ses propres mots : « Je vais ajouter ce rendez-vous à ton agenda Google : … Tu confirmes ? ». Il s'est bien arrêté avant l'écriture. Mais ce que tu confirmes doit rester le reçu lui-même.

La marge reste sur les résultats. La description précise maintenant : « un récapitulatif à confirmer se reproduit tel quel, mot pour mot, avec sa demande de confirmation ». Une question du reçu se pose toujours telle quelle.

Preuve réelle : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-07-typed-generic-answer/rollback-write-recap.json`.
