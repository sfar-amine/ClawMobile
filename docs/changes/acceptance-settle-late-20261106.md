# Recette de déploiement : une réponse différée est jugée une seconde fois en fin de recette (06/11/2026)

## Pourquoi
Deux déploiements sans lien avec ces routes ont été annulés pour le même motif :
- le 05/11, `/files?scope=session` ;
- le 06/11, `/control/automations`.

Dans les deux cas, la route répondait 200 dans son budget, mais restait « différée » plus de 15 s juste après le redémarrage, au moment où la recette lance toutes ses lectures. Ces calculs (Python, Gateway) prennent plus de temps pendant ce pic.

## Ce qui change
Une réponse différée qui n'a pas livré ses données dans les 15 s n'est plus jugée tout de suite. Elle est relue une fois toutes les autres lectures terminées, avec la même fenêtre de 15 s.
- Si elle livre ses données, le contrôle est `ok` avec `settledLate: true`.
- Sinon, il est `fail`, et le déploiement est annulé comme avant.

Les budgets de temps, les fuites et les autres contrôles ne changent pas.
