# S24 07/11/2026 21:46 — verified read, generic ready answer repeated by the brain

Real app turn « mon solde orange » (run `run_1794084366481_50f32742`). Copied from the playbooks fixture
`tests/fixtures/s24-2026-11-07-orange-typed-answer/` (same capture).

- The typed tool `samantha_maxit_tunisie` returned verified facts: eight Max it cards, `ok: true`.
- Its ready answer was the opaque receipt sentence « Le résultat de la demande reste à vérifier. ».
- The tool description said « Reproduis la réponse prête du reçu sans inventer de fait », so the brain
  answered exactly that sentence over a verified balance.

Amine (07/11): « Je veux toujours donner au modèle une certaine liberté justement pour rattraper si incohérence
ou autres. » The description now lets the brain answer from the receipt's verified facts when the ready answer
is generic, incomplete or contradicts them, still without inventing any fact.

No number, token or lease identifier is kept.
