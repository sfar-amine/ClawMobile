# ADR — LIFX local

Décision : UDP sur le LAN domestique, Graph et Companion existants. Identité stable (MAC) ; IP découverte. Ledger `nativeOperation` existant. Aucun store, routeur, scheduler ou démon ajouté. Aucun repli cloud, reset, flash ou changement réseau. Le S24 reste propriétaire. Perte de vérification : jamais un succès. API cloud et automatisation d'écran écartées par la demande locale.

Clarification (17/10/2026) : le coordinateur de dialogue V2.2 (`skill_intelligence/dialogue/`, ADR-DIALOGUE) est l'unique propriétaire de l'état de la question ; la lampe n'ajoute qu'une liaison de paramètres sans état, appelée par le Graph après sélection.

Statut : sources livrées, non déployées ; recette live avec Amine requise. Android utilise le capability-bridge et l'icône audio-lines existants. Retour arrière : revert du lot et activation précédente par les scripts normaux. Contrat : [58 — LIFX local (samantha-ui-playbooks)](https://github.com/sfar-amine/samantha-ui-playbooks/blob/main/docs/work/samantha-convergence/58_LIFX_Local.md).
