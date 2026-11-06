# Payer par Samantha : le Companion accepte la remise de paiement inerte

Constat S24 du 6 novembre 2026 à 21:59 : « paie ma facture SONEDE de 19,400 DT » s'est terminé par « route non active ». Depuis le passage au mode où le modèle traite chaque demande, aucun outil typé ne portait de paiement.

Côté playbooks (payment-brain-handoff-20261106), les outils SONEDE, Topnet et Maxit portent désormais l'action de paiement : risque `transaction`, mode `payment_handoff`. Le Companion accepte exactement cette forme, sans récapitulatif hôte, et refuse toute autre transaction. Il signale au modèle que l'action ouvre seulement la confirmation native et lui donne le budget de 120 s de l'assistant, car le devis Maxit peut à lui seul prendre 75 s.

Ordre de livraison : déployer d'abord ce Companion, puis activer le snapshot playbooks.
