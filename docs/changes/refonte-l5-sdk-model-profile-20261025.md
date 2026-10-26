# L5 — consommation native des réglages par conversation

Source préparée pour la sélection complète avant le premier modèle : compte, liste ordonnée de secours, effort et vitesse, puis modèle seul pour le résumé. Réutilisation de R6, du metadata owner natif SessionEntry, de ses transactions SQLite et du contexte SDK par run ; aucune nouvelle autorité métier.

Les12 modules/types du SDK2026.9.6 sont épinglés par version et SHA. Le propriétaire de compatibilité existant les applique et les restaure exactement ; runtime-sync et gateway-start vérifient leur appariement. Les pins conservent les sessions existantes avant CAS R6 ; les nouvelles admissions sont refusées pendant une configuration incertaine. L’héritage historique reste intact sans profil admis.

Fixtures : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-25-model-flow-sdk/PROVENANCE.json`, uniquement sources publiques lues sur le S24. Tests I/O rédigés explicitement :451sessions, génération changée, priorité conversation/flux/défaut, compte des secours, absence de préparation, clôture de la provenance et neutralité legacy. Les tests SDK exécutent les vrais préfixes et fonctions capturés, dont compaction et target de compte, plus l’intégralité apply/check/rollback avec types décompressés.

Tests ciblés de patchset, setup et compaction : PASS. Le 26/10, build TypeScript, contrats R6, pins par conversation et test SQLite interprocessus : PASS après correction de la compatibilité ES2021 et séparation des scénarios rédigés. Tous les nouveaux tests sont inscrits dans le workflow canonique. Ces contrôles de source ne valent ni CI complète, ni fusion, ni activation, ni recette réelle. PR en brouillon tant que ces preuves manquent.

NO_CAPABILITY : sous-contrat interne du réglage owner R6 existant ; aucune route, permission ou capability nouvelle. Aucune surface MCP, schéma Claw ou adaptateur changé. Paiement, admissions de données et protections des contacts inchangés.

Retour arrière : voir l’ADR ; restaurer les réglages R6 et leur provenance avant de retirer un SDK qui consomme les pins. Aucun rejeu d’effet incertain, aucun effacement de reçu, aucune suppression de pin pour fabriquer un succès.


Reprise26/10 : jonction terminée avec les preuves R6 par flux (`fieldsHash`), réservation du premier changement contrôlée avant héritage neutre, déclarations SDK max/ultra cohérentes. Refus avant effet d’une version précédente dont un ancien modèle/compte reste non qualifié pour le coût ; aucune configuration S24 nettoyée pour produire un PASS. Héritage de champs absents et retour au mode automatique natif conservés, projection Android explicite.

Fixture supplémentaire : `native-session-cas-snippets.json` provient des seuls extraits de code public du SDK S24,26/10, empreintes de modules et extraits incluses. `test-model-flow-native-session.cjs` est inscrit au job Node26 existant : véritables fonctions SDK sur ports SQLite locaux rédigés, deux conflits via processus distinct et451 lignes ; aucun modèle ni base privée. Les ciblés sont verts ; la CI finale reste à exécuter sur le head intégré, sans recette live revendiquée.
