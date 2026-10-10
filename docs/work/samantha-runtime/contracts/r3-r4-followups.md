# Suites R3/R4

DELETE avec encodage URI malformé : 400 invalid_run_deletion, pas 503. Cible déjà supprimée et nouvelle operationId : renvoyer le reçu canonique existant sans créer de reçu, modifier son timestamp ou consommer de capacité. L’operationId du reçu peut donc différer de celle de cette nouvelle requête. Conflits pour une operationId existante restent inchangés.

Fixture R4 alignée : TT indisponible est {state:unavailable,reason:selected_not_ready}, sans result. Contrats HTTP et affichage partial vérifient ces comportements. Aucun diff CI, store ou parcours paiement. Git uniquement ; recette et fusion par Claude.
