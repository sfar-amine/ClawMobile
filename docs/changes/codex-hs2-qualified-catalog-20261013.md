# HS2 — catalogue fondé sur les reçus qualifiés

Le catalogue ne sert plus les anciens statuts de facture sans expiration. Il relit le reçu qualifié produit par playbooks #93, affiche sa date et son heure, applique 24 h aux statuts et 1 h aux soldes, puis retire toute donnée expirée même depuis le cache chaud.

Le test ciblé utilise la capture S24 #176 et un volume de 50 002 reçus. Il couvre l’expiration exacte, l’altération, la cohérence du reçu extérieur, la neutralisation du format historique, le statut Orange, le badge factures et la relecture du cache.

Aucun parcours de paiement, store, fournisseur ou route n’est modifié. Retour arrière par revert de cette tranche, sans migration.
