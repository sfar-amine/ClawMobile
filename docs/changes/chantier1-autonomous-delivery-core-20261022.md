# Chantier 1 — exception de livraison autonome bornée

Le mandat explicite d'Amine du 22 octobre 2026 autorise Codex à porter seul le chantier 1 jusqu'à sa livraison réelle. Un paragraphe ciblé est ajouté à AGENTS et une ADR décrit la portée A12/A13 : rôles auteur/contrôles/intégration/fusion/déploiement/recette/rollback, sans attente de revue Claude ni d'audit indépendant.

L'obligation du relecteur distinct dans son propre conteneur est explicitement remplacée pour ce chantier par ce mandat de gouvernance ; elle n'est pas retirée par économie de temps. La CI canonique off-phone au head exact et au numéro de PR, la vérification de l'intégration finale, les fixtures, G1–G6 applicables, les limites NI, secrets/données/transactions et rollback restent obligatoires. Les autres chantiers sont inchangés. Aucun runtime, route, fournisseur, compte ou script de déploiement n'est modifié.

Le mandat est conservé dans l'événement canonique `2620cc1d2da3f09913a36821f9f0894defa446cc4bef030b8c1cb6c55be032a4`. Cette modification documentaire ne dit pas qu'une activation a eu lieu. Retour arrière : retirer l'exception et son renvoi par une nouvelle décision documentaire ; ne pas effacer de preuves ou modifier de code pour ce retrait.

Voir [l'ADR](../08-decisions/ADR-20261022-chantier1-autonomous-delivery.md).
