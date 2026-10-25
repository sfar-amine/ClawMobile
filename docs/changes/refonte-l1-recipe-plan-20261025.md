# L1 — plan de recette préparé

Douze scénarios de la spécification et schéma fermé ; validations dans le propriétaire `companion-acceptance.py`, mode explicite sans appel runtime. Les attentes sont confrontées au registre, au mapping du Graph et aux manifestes du SHA de provenance, sans résolution textuelle. La CI réutilise le validateur QA déjà épinglé.

Le document `docs/work/samantha-refonte/L1-recette-proprietaire-et-baseline.md` distingue collecte de référence, conformité fonctionnelle et provenance réelle par surface. Aucune baseline ni recette n’est revendiquée. L0 demeure une porte. Aucun effet sur MCP, aucune nouvelle capability ni architecture. Les gardes de déploiement et de paiement ne changent pas.

Validation ciblée : cinq tests du plan et trois tests historiques de transport propriétaire PASS. Le test historique de recette Web exige son propriétaire TypeScript compilé ; le worktree neuf ne possède pas `dist/companion/runWeb.js`, donc ses 14 initialisations ne sont pas qualifiées. La compilation est différée pendant la CI canonique concurrente pour préserver les budgets mesurés. Aucun PASS global ni régression métier n’est déduit de ce prérequis absent.
