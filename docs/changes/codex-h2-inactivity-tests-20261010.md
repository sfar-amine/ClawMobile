# H2 — inactivité déterministe

Remplace sleeps et polling par une horloge injectée et des barrières Promise.
Le pass inclut sa persistance avant le scénario suivant. Les assertions et
le transport CLI/SQLite sont conservés. [Contrat H2](../work/samantha-runtime/contracts/h2.md).

Reprise42 : base `5631fe9d` intégrée normalement ; build et trois suites ciblées passent (preuve locale `h2-lot3-targeted.log`). Publication conditionnée par la CI entière verte au SHA exact, sans recette S24 revendiquée.
