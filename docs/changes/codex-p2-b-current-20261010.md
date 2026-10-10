# P2-b — activation et essai avec reçu

Détail enrichi, activation par skills.update et essai via submitIntent existants. Les opérations persistent dans le registre actuel ; aucun nouveau store ni effet bancaire. Contrat : docs/work/samantha-runtime/contracts/p2-b.md.

Validation : statistiques, owner exact, essai, restart/replay, concurrence, protection et incertitude ; toutes les commandes CI runtime. CI inchangée pendant R6 #27. Qualification S24 par Claude après fusion.

Revue 26 : base 0bf30ab intégrée sans force-push, garde financière commune sur sources complètes, deadlines Gateway explicites, acceptance GET/guards et CI test-skill-control. Aucune fixture S24 ni qualification RPC physique inventée.

Relecture GitHub et union R8 : paiement partagé AUTOMATION_PAYMENT_PATTERN/protectedPayment ; base 6b7c68f, routes mémoire, toutes étapes CI, settle et LEAK secrets conservés.

Reprise Claude (Codex en pause) : `inferRisk` utilise le motif partagé sur toutes les sources (fast paths en risque haut), « régler 50 TND » testé tel quel, budgets Gateway explicites mesurés (capture S24 `skills.status`, cache 15 s, attente GET plafonnée à 3 s, activation ≤ 17 s), lignes de recette sur une skill réelle sans argument, capability `NO_CAPABILITY`.
