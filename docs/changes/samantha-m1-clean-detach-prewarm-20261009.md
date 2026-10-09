# Companion M1 — préchauffage après detach v2 propre

Base : correction d’horloge de Claude 4e971f5, sur la PR privée #1 sfar-amine/samantha-core. Source du besoin : recette S24 communiquée par Amine, checkpoint 489395c8 ; délai suivant detach 3,0–3,4 s versus 0,12 s à chaud. Aucun résultat runtime supplémentaire acquis depuis le cloud.

Après une fermeture WebSocket normale (1000) d’un owner v2 dont le provider était prêt, le handler conserve resetProvider(v2_owner_detached), ferme le recorder du sid, efface la corrélation de tours, puis appelle prewarmDefault existant. Le provider neuf reste sans owner/conversation/historique ; l’attach suivant adopte ce provider ou attend sa connexion partagée. Aucun token supplémentaire si le préchauffage est déjà en cours. Les callbacks de l’ancien provider restent invalidés par la génération existante.

Pas de préchauffage automatique après fermeture anormale, detach pendant connexion/setup ou shutdown. Le mode legacy garde son comportement. Les erreurs utilisent uniquement les trois tentatives bornées du prewarm existant ; aucun nouveau retry loop, timer ou orchestrateur. Les étapes d’un préchauffage sans sid ne sont pas inventées dans C1.

Tests : nouveau test-claw-live-warm-detach.cjs, 7/7 ; horloge Claude 12/12 ; HTTP/WS A11 11/11 ; perturbations A13 6/6 ; protocole 14/14 ; A9/A10 10/10 ; suites Warm, cancellation et ownership réussies ; TypeScript build réussi. La CI privée exécute désormais la nouvelle suite. git diff --check requis ; aucune mesure live de latence prétendue.

Prochain propriétaire : Claude pour revue et recette labo du correctif sur S24 selon le checkpoint existant. Vérifier une deuxième session après detach normal et après attach immédiat, absence d’ancien audio/outcome et mêmes sid/turn. La route barge-in …DZH2 versus appareil …DZI1 reste à requalifier au RDV1, hors de ce correctif. Aucun déploiement automatique ni gate M1 annoncé.

Rollback : revert du seul commit. Le déploiement labo déjà annoncé par Amine concerne 4e971f5 ; cette correction Git n’a pas été activée depuis le cloud.
