# C16 — causes natives rendues par le propriétaire de présentation

La CI exhaustive de présentation s’arrêtait sur `native_pulse_protocol_required` : le producteur avait ajouté ce code et `native_pulse_execution_unknown` sans leur phrase dans le rendu typé. Les littéraux en quotes simples du même producteur échappaient aussi à l’inventaire de test précédent. Le protocole, l’exécution et les gardes ne sont pas modifiés.

`receiptPresentation.FAILURE_PHRASES` porte désormais les phrases françaises et anglaises des causes natives C16 de transport, accès, préparation, confirmation et refus du formulaire. Les quatre causes de lecture C18 déjà publiées sont couvertes pour la composition descendante. Chaque cause a sa propre phrase ; aucun code interne n’est récité ou interpolé depuis un texte client.

Le rendu de la pièce Pulse réutilise ces mêmes phrases pour les erreurs techniques et les échecs/refus natifs connus. Un accès non établi n’est plus présenté comme une simple demande hors de la famille Pulse. Un formulaire modifié depuis l’accord est expliqué comme tel, au lieu d’une panne de préparation générique. Les refus métier de scope et les anciennes entrées sans pilote natif conservent leur traitement.

Une absence de protocole ou un résultat inconnu **ne prouve pas zéro effet**. Ces phrases demandent la vérification du résultat et ne proposent aucun nouvel essai automatique. Elles ne prétendent pas que rien n’a été exécuté. Les seuls textes « rien exécuté » réutilisés sont ceux des gardes d’admission/préparation qui refusent avant l’effet. Aucun retry, interprétation, droit, secret ou fallback ajouté.

Le test exhaustif existant conserve toutes ses assertions et collecte aussi les quotes simples, les `reasonCode` du producteur Node, les erreurs du propriétaire d’accès natif et les codes publics du helper Python. Le contrat de schéma HS3, le rendu parlé, la conservation de cause en statut/relecture et les garde-fous contre textes privés restent vérifiés. Les nouvelles contre-épreuves traversent le vrai rendu de pièce avec un port d’accès MOCK_ONLY et un faux résultat de transport, sans fournisseur, téléphone ni effet métier.

Retour arrière : revert du seul correctif de présentation. Aucun état à migrer ou nettoyer ; les reçus existants gardent leur code et ne doivent jamais être réexécutés pour changer leur texte.
