# HS2 — consommation des reçus qualifiés dans le catalogue

Le catalogue Companion consomme uniquement `result.qualified_receipt`, produit dans le reçu Capability Graph existant par playbooks #93 (`f8df994`). Il ne reconstruit plus un statut depuis l’ancien résultat brut de facturation, depuis `completedAt`, depuis un paiement confirmé ni depuis la date de génération du catalogue.

Le contrat accepte deux classes : `general_status`, valable 24 heures, et `balance`, valable 1 heure. `observedAt`, `expiresAt`, `ttlSeconds`, `observedDisplay`, la complétude, le succès, les items et `sourceReceiptRevision` sont tous validés. Le reçu extérieur doit être terminal et réussi, son exécution doit être terminée avec le code 0 et sa capability doit correspondre à l’enveloppe. Une incohérence omet le statut.

Chaque texte exposé par le catalogue contient `observedDisplay` sous la forme `JJ/MM/AAAA HH:MM UTC`. `at`, `checkedAt`, `expiresAt` et `observedDisplay` restent aussi structurés. Les statuts de facture qualifiés sont attachés aux groupes STEG, SONEDE et Topnet ; le solde Orange qualifié est attaché au groupe Orange. Un badge de factures impayées reprend le même horodatage visible.

La relecture a lieu pendant le scan des reçus puis avant chaque réponse de catalogue. Cette seconde vérification retire les statuts expirés d’une projection conservée dans le cache chaud : une lecture ou une régénération ne renouvelle jamais la date propriétaire. Les champs historiques sans `qualified_receipt` sont ignorés et une absence n’est pas convertie en zéro.

La source demeure `~/.openclaw/remote-bridge/requests/<requestId>.json`, déjà possédée par le pont. Le scan et son mémo en mémoire restent bornés, sans nouveau store, appel fournisseur, réseau, Gateway, scheduler ou route. La capture nettoyée S24 #176 (`fixtures/s24-2026-10-11/hs2/qualified-receipts-owner.json`) fixe les formes sources de facturation et Orange ; l’enveloppe est le contrat inter-dépôts de playbooks #93. QA reste absent jusqu’à un résultat terminal réel qualifié.

Retour arrière : rétablir le lecteur précédent et retirer les champs optionnels du catalogue. Aucune migration n’est nécessaire. Claude garde la fusion, le déploiement et la recette S24 après activation coordonnée de playbooks #93.
