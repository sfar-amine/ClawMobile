# R1 — composants santé en défaut

La projection fixe de trois composants masquait des défaillances présentes dans le verdict canonique, notamment control_plane.maintenance. Le Companion complète Contrôle v2 à partir du même verdict, avec libellés FR/EN, données filtrées et révisions cohérentes.

Validation : build TypeScript, contrat control-health-components et trace-induction réussis. Installation npm avec cache sous /tmp (cache utilisateur inaccessible dans cette tâche). Aucun nouveau propriétaire ni changement de parcours paiement, Android ou M1.

Architecture inchangée : projection read-only au sein de la façade existante. Les six primitives MCP conservent leurs contrats et comportements. Contrat détaillé : doc 27, C12.

Livraison Git uniquement ; recette, reçu S24 et activation attendent Claude. Retour arrière : revert du commit R1 ; aucune migration de données.
