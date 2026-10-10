# K2 — Proposition de renouvellement R17, contrat seulement

Le [contrat K2](../work/samantha-runtime/contracts/k2.md) propose à Amine un rappel au propriétaire dans les 24 h précédant l’échéance et la prolongation biométrique R17 existante de 1, 3 ou 5 jours. Aucun code, route, envoi, état runtime, capability d’exécution ou test nouveau n’est ajouté.

Le contrat distingue les faits R17 des décisions : cas du rappel immédiat d’un accès de 1 jour, propriétaire de livraison, reçu et déduplication durable encore à confirmer par Claude. Le balayage confirmé lit au plus 200 blocs de 2 Ko ; aucune pagination ni couverture des fichiers non lus n’est affirmée. Une décision de contrat ne vaut pas activation.

Vérification locale : validateur documentaire existant des playbooks appliqué à tout le dépôt core, aucune erreur de lien ; diff sans erreur d’espacement. Note v2 limitée aux trois fichiers de cette proposition. Le gate de livraison reste volontairement bloqué tant que la décision et le mécanisme de livraison ne sont pas confirmés. Aucune recette S24 n’est exécutée ni revendiquée.

Retour arrière : retirer uniquement cette proposition et sa note ; aucun effet runtime à restaurer.
