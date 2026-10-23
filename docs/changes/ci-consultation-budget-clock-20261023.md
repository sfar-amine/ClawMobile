# CI — origine d’horloge du budget consultation

Le rejeu canonique core394 f954 a échoué à l’étape119 : le test d’égalité
exacte calculait 43.999999999999545 contre44.0. Le même test avait passé au
premier run. La fraction de l’uptime monotone du conteneur introduit un arrondi
binaire lors de deadline - reserve - now ; aucun budget dépassé n’est observé.

Le test sans dépendance à une durée écoulée prend maintenant now=1000.0,
comme le test voisin de préparation/verrou. Son assertEqual strict est conservé,
ainsi que les vérifications de marge sur les captures S24 et tous les seuils.
Les autres tests gardent le timeout réel et la restauration.6/6 passent.

Aucun changement du garde réseau, du paiement, des budgets ni de la production.
Pas d’impact capability ou architecture ; test déjà inscrit dans ci.yml.
Nouvelle CI complète sur head exact nécessaire. Retour arrière : revert test.
