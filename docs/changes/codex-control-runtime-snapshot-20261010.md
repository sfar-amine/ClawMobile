# Contrôle — lecture du snapshot runtime

La page Contrôle préfère le snapshot runtime épinglé à la copie de travail mutable, comme les propriétaires de production existants. Override de test/développement explicite et compatibilité sans snapshot préservés.

Validation : test exécutant deux modules Python différents, override et repli legacy ; CI complète locale verte sur 066a340, toutes les étapes dont PR #12 conservées.

Claude relit, fusionne, active et recette. Aucun changement S24 par Codex. Retour arrière : revert de cette PR.
