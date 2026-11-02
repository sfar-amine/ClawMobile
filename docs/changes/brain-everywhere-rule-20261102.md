# Le cerveau partout : règle d'agent du 02/11/2026

Décision globale d'Amine du 02/11, enregistrée dans les playbooks
(`docs/08-decisions/ADR-20261102-brain-everywhere.md`) : sur toutes les surfaces, le modèle est le cerveau. Il lit la
demande, choisit un outil typé ou un skill, lit le résultat vérifié et rédige la réponse. Les contacts des pièces suivent
le même chemin qu'Amine : un seul chemin, sans interrupteur ni repli natif.

Ce changement :
- ajoute à `AGENTS.md` la section courte « Le cerveau partout ». Aucun hook (`before_dispatch`, `inbound_claim`…) ni
  réponse `handled: true` ne décide de l'intention à la place du cerveau ; la sécurité reste au code ; l'amélioration
  continue passe par PR, CI et recette ; la performance suit l'état de l'art du 02/11 (#520, `direct-only`) ;
- ajoute un renvoi « remplacé en partie » dans `ADR-20261025-brain-only-typed-tools.md` et
  `ADR-20261026-pulse-scoped-brain.md`.

Documentation seule : aucun code runtime, aucune route, aucun déploiement. La branche `claude/room-brain` n'est pas touchée.

Retour arrière : revert du commit.
