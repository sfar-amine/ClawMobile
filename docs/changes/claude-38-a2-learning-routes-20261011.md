# 38 A2 — routes Companion d'apprentissage

`GET /v1/learning/associations` (500 ms), `POST /v1/learning/associations/{id}/forget` et `POST /v1/learning/not-this`
(3 s) via le propriétaire playbooks `reporting.control_learning` (engineering.learning_gate, improvements.db). Trace
`notThis` bornée sur le run existant. Lignes de recette et test CI ajoutés ;
[contrat](../work/samantha-runtime/contracts/38-a2-learning-routes.md).
