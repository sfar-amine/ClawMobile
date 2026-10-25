# L1 — plan de recette préparé

Douze scénarios de la spécification et schéma fermé ; validations dans le propriétaire `companion-acceptance.py`, mode explicite sans appel runtime. Les attentes sont confrontées au registre, au mapping du Graph et aux manifestes du SHA de provenance, sans résolution textuelle. La CI réutilise le validateur QA déjà épinglé.

Le document `docs/work/samantha-refonte/L1-recette-proprietaire-et-baseline.md` distingue collecte de référence, conformité fonctionnelle et provenance réelle par surface. Aucune baseline ni recette n’est revendiquée. L0 demeure une porte. Aucun effet sur MCP, aucune nouvelle capability ni architecture. Les gardes de déploiement et de paiement ne changent pas.

Validation ciblée : cinq tests du plan et trois tests historiques de transport propriétaire PASS. Après compilation TypeScript du head `cbdbc3e1`, les quatorze tests historiques de recette Web passent également. L’échec de prérequis initial (propriétaire `dist/companion/runWeb.js` absent du worktree neuf) reste conservé dans le log privé `l1-core-web-prerequisite-failure.log`. Le succès suivant est dans `l1-core-web-after-build.log`, SHA256 `4e13974b42e4f2036f7c6172580c3dadf92f6e24d8ebf737295d12c02eca17c6`. Aucun effet S24 ni PASS de CI canonique ou de recette métier n’est déduit de ces tests ciblés.
