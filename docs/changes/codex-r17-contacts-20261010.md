# R17 — liste blanche WhatsApp complète

Lot unique intégré sur runtime `af4132a` : extension people-trusted, adaptateur Companion, contrôles HTTP et biométrie, reçus/rejeu, contexte privé, activité réelle et balayage dans le cycle health-manager existant. Aucun paiement, nouvelle table, store, registry, scheduler ou daemon.

Validation : 21 tests owner R17, trois tests du cycle health-manager, 21 tests people-trusted existants, matrice HTTP, test croisé HTTP → vrai contrôleur → SQLite/config CAS de fixture, build et commandes CI existantes. Reprise avant effet avec preuve signée consommée une seule fois ; une autre opération ne peut réutiliser cette preuve. Unicode (2000 caractères, y compris JSON échappé) et taille physique HTTP testés. Aucun numéro, nom ni note dans l'historique public ou les diagnostics.

Les étapes CI sont conservées ; les nouveaux tests sont exécutés séparément pendant l'inscription coordonnée des étapes. Le contrat précise les bornes du balayage et la qualification restant à Claude. Aucun déploiement ou recette S24 par Codex. Retour arrière : revert du lot.
