# R5 — Automatisations sous 300 ms

Base runtime `af4132a`, avec toutes les étapes CI de R6 conservées. Le pool Contrôle existant poursuit un calcul canonique borné ; la première réponse du contrat 2 est différée si le calcul prend plus de 180 ms, sans inventer de données. Le cache frais est limité à 15 s et invalidé par la révision du fichier scheduler existant, vérifiée aussi avant publication.

Mesure locale avant/après sur un propriétaire simulé lent : 1877,54 ms / 193,65 ms pour la réponse différée à froid ; 2,10 ms en cache. CI courante rejouée localement sur cette base ; nouveau test R5 exécuté séparément avec ci.yml inchangé. Aucun changement paiement, scheduler, store ou déploiement. Le chemin réel du scheduler, le chargement différé Android et le budget S24 restent à qualifier par Claude.

La mesure froide est une réponse de chargement sans données : elle ne prouve pas que le collecteur lent fournit une liste en moins de 300 ms. V5 #34 a été livré avant la relecture R5 ; aucune recette physique S24 n’est déduite de cet ordre Git-only.
