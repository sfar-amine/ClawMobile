# N1 — cause factuelle de l’erreur de traitement

Le Companion masquait les causes du lecteur canonique (`helper_missing`, `helper_failed`, `invalid_result`, `invalid_check_budget`, `check_budget_exceeded`) sous une seule indisponibilité. Après une résolution EXECUTE préparée, une erreur de transport était même décrite comme un changement d’état de la capability. Ces constats ne permettent pas de déduire le résultat métier.

La présentation HS3 existante conserve les causes connues dans `failure.step`, `failure.reason` et `failure.reasonCode`. Le refus pendant la résolution expose ce reçu directement ; un résultat d’exécution illisible garde un effet inconnu. Les reçus canoniques HS3 valides priment ; les codes inconnus, détails bruts et textes privés ne deviennent pas une cause inventée. Aucun changement paiement, exécuteur, route, budget ou retry.

Tests préparés : décision Orange READ de la capture O7/O8 existante ; conservation des projections générées sur captures S24 ; injections de panne du helper clairement synthétiques. Inscription dans l’étape CI HS3. Aucun appel live opérateur ni recette S24 réalisé. Le trajet réel « Browse Lines » / `userText` / `titlePreview` et l’erreur précise restent à capturer par Claude ; les erreurs génériques de l’app sont traitées dans la PR N1 Android liée.

Le titre de prévisualisation provient du premier `userText` authentique conservé, sans repli sur un prompt routé ni une présentation. Une demande qui dit littéralement « Browse Lines » reste intacte ; aucune blacklist lexicale. La couverture existante indique que l’historique est retenu, pas exhaustif. Le titre Gateway propriétaire reste un champ séparé.

Les demandes forfait/soldes passent par le registre et le Capability Graph canoniques, corrigés dans le lot N1 playbooks. Aucun pré-routeur Orange dans le Companion.

Retour arrière : revert du lot N1 core ; aucune migration ni activation par Codex.
