# V4 — rapport automatique des latences

L’analyseur A10 existant produit un bloc startup à chaque exécution, apparié strictement par sid, source et turn=0. Il distingue p95 descriptif et qualifié, comptes manquants, inversions, exclusions de dérive et frontière historique tronquée. Le marqueur explicite non tronqué V2 permet le seuil strict >1 ms ; les anciens tests A10 >=1000 µs restent conservés.

Tests V4 7/7 et corpus/analyseur 10/10 passent ; CI courante af4132a entière rejouée, ci.yml inchangé. Rapport fourni10/10 mesure3 reproduit : trois pairs, app p50 367,70 ms/p95 descriptif391,62ms, aucune exclusion, aucun KPI acoustique ou M1 validé. Hashes des sources et limitations sont documentés. Aucun déploiement, store, scheduler, daemon ou mutation paiement. V2 #37 est une dépendance de couverture historique, sans inclusion de ses commits dans cette PR.
