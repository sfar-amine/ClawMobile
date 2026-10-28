# Outils typés : le modèle dit si l'appel répond ou ouvre une demande — 28 octobre 2026

Décision d'Amine du 28/10, recommandation 5. Chaque outil métier typé expose un champ facultatif `relation` (`answer` ou `new_request`), et sa description demande au modèle de le remplir quand une question de l'outil attend une réponse. L'hôte transmet le champ à l'appel typé des playbooks et refuse toute autre valeur. ADR : `samantha-ui-playbooks/docs/08-decisions/ADR-20261028-model-decides-relation.md`.

À déployer après l'activation des playbooks qui acceptent `relation`. Retour arrière : revert puis redéploiement du core.
