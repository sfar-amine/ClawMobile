# « Annule » affiché comme une annulation (30/10/2026)

Recette Pulse sur le S24 : « Crée un nouveau projet » puis « Annule la demande en cours ». Le coordinateur fermait
bien la demande (`CANCELLED`, « J’ai arrêté la demande en cours. »), mais la surface ne connaissait pas ce résultat :
elle le traitait comme une panne et la pièce répondait « Le suivi de conversation est indisponible. ».
`CANCELLED` rejoint les résultats terminés de `dialogueSurface.ts` ; la phrase du coordinateur est affichée.
