# Paiement : la suite d'un paiement démarré n'exige plus le déclencheur consommé

Le 6 novembre 2026 à 23:52, Amine fait le premier paiement SONEDE réel par la conversation. La biométrie est acceptée, puis il annule sur la page ClicToPay/3-D Secure. L'app intercepte le retour SONEDE `/api/newpaiement/rejectpay/…` et le transmet au Companion.

Le Companion refuse alors ce retour, puis la vérification de secours lancée après 60 s. Le déclencheur SONEDE à usage unique, consommé au démarrage, était encore exigé. Le reçu est resté en « action bancaire requise » et bloquait toute nouvelle tentative sur la facture 312854662. La relecture SONEDE de 23:58 le confirme : facture toujours due, rien d'encaissé. Un paiement réussi serait resté non confirmé de la même façon.

Désormais, la suite d'un paiement déjà envoyé n'exige plus le déclencheur : retour bancaire, vérification de secours, reprise. Elle ne fait que lire la passerelle et le fournisseur, sans jamais soumettre à nouveau. Démarrer un nouveau paiement exige toujours le déclencheur armé.

Au redémarrage, le Companion reprend le reçu resté ouvert, relit la facture et le clôt.
