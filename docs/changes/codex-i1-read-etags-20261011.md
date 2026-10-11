# I1 — lectures conditionnelles sur projections exactes

Six lectures existantes reçoivent un ETag fort du corps JSON réellement servi.
If-None-Match donne 304 et aucun corps uniquement après les gardes et la lecture
propriétaire, si la projection est identique. Refus, mutation et différé exclus.
Caches et en-têtes de confidentialité existants restent inchangés.

Tests HTTP sur captures S24 natives/Gateway, latences capturées et budgets de la
recette existante. Données et TTL changés imposent un nouveau 200 ; aucune métadonnée
de fraîcheur retirée du hash. Le gain de transfert est mesuré localement ; recette
physique et client restent chez Claude. [Contrat](../work/samantha-runtime/contracts/i1.md).
