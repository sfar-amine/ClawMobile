# R18 — corrections de relecture fichier32

Base runtime6b7c68f et R11 correctif dbdb89b intégrés, union CI conservée. Les options viennent de thinkingOptions de la session (fallback thinkingLevels[].id), sans liste de niveaux supposée ; max et ultra sont acceptés quand proposés. Sans options, niveau null. Jauge fraîche et réflexion utilisent une lecture partagée.

Fixture installée core#48 sessions.list (2376ms) raccordée aux tests : 8 niveaux, défaut low, contexte8%, lignes périmées/null, profil absent et revalidation sur le profil courant. Une mutation combinant modèle et réflexion est refusée avant effet : deux requêtes distinctes, pour éviter un effet partiel non validé. Recette absence de fil/404 skipped, erreurs503 et dépassements conservés.

Le NO_CAPABILITY temporaire est remplacé par les trois capabilities planned de la [PR playbooks jumelle #30](https://github.com/sfar-amine/samantha-ui-playbooks/pull/30), tête a3d7c6a ; fusion/épinglage playbooks puis R11#28 puis R18#54 par Claude. Aucun adaptateur V6 parallèle ni activation ajoutée. Retour arrière : revert, sans migration. Captures réelles attestées ; budget total POST et recette de route restent à mesurer par Claude.
