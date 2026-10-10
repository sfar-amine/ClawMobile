# R5 — Automatisations sous 300 ms

Base runtime `639ae68`. Le pool Contrôle existant poursuit un calcul canonique borné ; la première réponse du contrat 2 est différée si le calcul prend plus de 180 ms, sans inventer de données. Le cache frais est limité à 15 s et invalidé par la révision du fichier scheduler existant, vérifiée aussi avant publication.

Mesure locale avant/après sur un propriétaire simulé lent : 1871,04 ms / 193,47 ms à froid ; 2,23 ms en cache. CI courante rejouée localement ; nouveau test R5 exécuté séparément pour laisser ci.yml à R6. Aucun changement paiement, scheduler, store ou déploiement. Le chemin réel du scheduler, le chargement différé Android et le budget S24 restent à qualifier par Claude.
