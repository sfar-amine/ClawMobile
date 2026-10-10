# P2-d — mémoire avec aperçu/import sélectionné

Lecture paginée, catégories/révision, oubli logique et import transactionnel par le propriétaire Memory Core existant. Contrat : docs/work/samantha-runtime/contracts/p2-d.md. Aucune écriture en aperçu et aucun historique Companion créé.

Validation : SQLite et HTTP réels, confidentialité, atomicité/replay et régressions Memory Core/CI. Les scripts Termux utilisent une copie temporaire à shebang portable pour le contrôle Cloud. Aucun déploiement Codex ; playbooks avant Companion, recette par Claude.

Intégration : bases playbooks d13ed9b et Companion 9a04980. Les conflits ont été résolus en conservant les routes récentes et les entrées mémoire/P2-c/P2-f du registre. Validation locale : build Companion, 5 tests SQLite, HTTP mémoire, workflows existants et contrôles de livraison ; régressions Termux via copie à shebang portable. Aucun test S24 déclaré. CI sans nouvelle modification propre à P2-d.

Corrections fichier 26 : grand aperçu arabe borné, échec pré-effet typé, reçu SQLite préservé après panne archive, secrets supplémentaires filtrés ; tests HTTP/SQLite locaux et CI/acceptance ajoutés dans Companion, sans recette S24. Bases 2ba0e72 / 0bf30ab intégrées sans force-push.
