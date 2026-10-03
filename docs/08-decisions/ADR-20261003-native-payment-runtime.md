# ADR — Confirmation native partagée pour les paiements

Décision : étendre le Companion et l'application Android privés existants, avec un client Python commun aux canaux. Les fournisseurs gardent des adaptateurs distincts. Seule la démonstration sans transaction est activée dans ce lot.

Le registre existant runs.json conserve un tableau paymentRequests avec écriture atomique, synchronisation disque et sérialisation dans le processus Companion. Ces entrées ne sont pas évincées avec les conversations. Le seul propriétaire d'exécution reste Companion ; le client Python appelle son API et ne modifie jamais directement ce registre. Aucun nouveau service, base, scheduler, moteur de reprise ou ledger financier.

Une activité Android dédiée utilise une clé Keystore authentifiée à chaque usage et signe un challenge borné lié à la demande et à son contenu. Le geste du propriétaire se produit dans le composant applicatif, sans reprise financière par l'agent. Le succès booléen du prototype Termux:API est insuffisant pour ce contrat. L'installation épingle uniquement une clé publique ; pas d'enrôlement HTTP.

La consommation et le garde de soumission sont durables avant l'appel d'adaptateur. Revalidation de la facture, fenêtre de 120 secondes, exclusion des doublons métier live et résultat indéterminé sans retry protègent les reprises. Succès et rejet nécessitent leurs preuves ; la disparition d'un impayé ou la réception d'un message ne suffisent pas.

Conséquences : client Python léger, petit composant natif pour l'écran système, logique partagée dans le runtime déjà installé. Android et runtime doivent être installés dans des versions compatibles. La limite de 1 000 demandes conservées impose un arrêt explicite avant toute future politique d'archivage, qui devra préserver les gardes. Le trust model reste le propriétaire local ; les autres applications ne reçoivent ni clé privée ni autorisation via un Intent.

Les modules de paiement réels, la seconde authentification bancaire, le retour positif fournisseur et les notifications de repli sont des intégrations supplémentaires, non déduites des tests de démonstration. Retour arrière : restaurer l'APK et le runtime précédents, conserver les données du registre et ne rejouer aucune demande.
