# R10 — demande liée à son fil à la création

Le transport Companion transmet son identifiant de fil exact au skill existant, puis à Memory Core via --session. Origine immutable, anciennes demandes null, aucun rapprochement heuristique. Contrat : docs/work/samantha-runtime/contracts/r10.md.

Validation locale : 6 tests Bash/SQLite, registre réel + CLI Gateway simulée, façade Control, build et CI existante, six suites mémoire via shebang portable. Aucun effet S24 ni paiement. Base ff12f8a ; playbooks fusionné/épinglé avant Companion par Claude.

Intégration R7 : base actuelle e315321, build et tests R7/origine/façade rejoués ; CI complète passée sur ff12f8a et inchangée entre les deux bases.
