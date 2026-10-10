# H2 — inactivité déterministe

Remplace sleeps et polling par une horloge injectée et des barrières Promise.
Le pass inclut sa persistance avant le scénario suivant. Les assertions et
le transport CLI/SQLite sont conservés. [Contrat H2](../work/samantha-runtime/contracts/h2.md).
