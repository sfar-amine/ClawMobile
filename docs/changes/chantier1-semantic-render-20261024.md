# Chantier 1 : rendu des exécutions passées par l'interprète

Depuis l'activation de l'interprète (23/10), une exécution terminée d'un tour de dialogue remontait sans texte : le backend
des playbooks renvoie l'exécution du Graph telle quelle, et seul le chemin lexical du helper la rendait. L'app affichait alors
« Claw completed the capability. » au lieu du résultat métier.

Le rendu d'une exécution terminée est désormais une seule fonction du helper (`_completed_execution`), utilisée par le chemin
lexical et par le chemin de l'interprète. Seule une exécution terminée sans phrase du propriétaire est rendue ; échecs, attentes
et phrases du propriétaire gardent leur présentation. La décision figée du dialogue reste celle de la réponse.
