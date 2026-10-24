# Entrée IA et délégation de lecture durable — 24 octobre 2026

La recette S24 après Core404 appelle réellement Gemini pour la consultation des factures. Elle révèle ensuite intent_durable_owner_unqualified : le host transmettait sa lecture durable au port direct, qui conserve volontairement le refus des écritures et des délégations non qualifiées. Ce refus n’est pas converti en succès ni contourné par une tâche courte.

Le host traite désormais la lecture durable avec son exécuteur existant execute_resolved / _durable_capability_execute, Bridge et Continuum. Il vérifie l’admission privée courante, reprend la décision figée et transmet une référence de dialogue bornée. La jumelle playbooks310 relit la base privée pour revalider cette référence avant tout appel métier. La référence JSON seule ne donne aucun droit. Les digests du catalogue/contexte restent vérifiés par le Graph. Le texte exact est conservé à travers les alias et les transports, y compris ses espaces.

Les identités de tâche, tentative, requête et effet sont celles du propriétaire durable existant. Un timeout conduit à observer le même reçu, sans nouvelle interprétation ni soumission aveugle. Le règlement partiel et sa carte restent ceux de PB309. Les écritures, confirmations natives et paiements conservent leur parcours. Aucun nouveau store, routeur, scheduler, modèle, droit ou exécuteur ; budgets inchangés.

La recette source jumelée utilise le vrai dialogue et Graph PB310 au SHA immuable, une base privée temporaire avec deux connexions et le résultat partiel capturé sur S24. Elle vérifie un seul appel d’interprétation, une seule exécution, la reprise du reçu original et le refus avant dispatch d’un faux store ou d’une révision périmée. Le test Node exerce le transport réel des arguments vers un helper Python inerte et refuse écriture, appelant tiers, tableau ou référence surdimensionnée. Ces tests sont ajoutés à la CI canonique complète hors téléphone, sans retirer de commande.

Mesure réelle avant ce lot : Gemini a répondu en 3649 ms pour l’interprétation (un échantillon, pas un p95 ; ne prouve pas la cible de 2 s). Aucun paiement de recette, aucun secret dans les fixtures ou journaux. Le refus réel et l’appel modèle restent préservés dans le dossier S24 billing-screen-20261024.

Activation : pin playbooks310 vérifié puis companion-deploy.sh sur le head intégré et vérifié ; recette réelle nouvelle en lecture. Retour Corec62c8d54c61b6e27d1cf4e6372215d268c7a98fb et PB23ee4daeada8949da725957c399348e00c493b36 par leurs propriétaires existants. Préserver les reçus originaux.
