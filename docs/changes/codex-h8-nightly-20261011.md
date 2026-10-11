# H8 — recette nocturne et dérive

Recette du checkout en lecture et refus owner seulement, sous verrou et préflight de déploiement existants. Les reçus nocturnes étendent le dossier deploys, médiane sur sept nuits, rétention trente reçus et une tentative de notification par jour. Contrôle Santé lit la preuve avec le libellé « Recette nocturne ».

[Contrat H8](../work/samantha-runtime/contracts/h8.md). Captures S24 de métadonnées installées et reçus de déploiement nettoyés ; aucun passage nocturne live exécuté par Codex. Job dans le planificateur existant, activation et première recette par Claude.

Régression corrigée : un parent réussi ne laisse plus un descendant vivant. SIGKILL du groupe isolé puis vérification bornée de sa terminaison précèdent la libération du verrou. Test réel avec descendant prêt, stdout fermé. Le seuil de médiane demeure littéral, même à zéro, sur les durées au centième.
