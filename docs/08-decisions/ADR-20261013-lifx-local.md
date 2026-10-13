# ADR — LIFX local

Décision : UDP sur le LAN domestique, Graph et Companion existants. Identité stable ; IP découverte. Ledger nativeOperation existant. Aucun store, routeur, scheduler ou démon ajouté. Aucun repli cloud, reset, flash ou changement réseau. Le S24 reste propriétaire. Perte de vérification : jamais un succès. API cloud et automation écran écartées par la demande locale.

Statut : sources candidates ; activation et recette live requises. Android utilise le capability-bridge et audio-lines existants. Retour arrière : revert du lot et activation précédente par les scripts normaux.
