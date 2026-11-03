# Tes messages WhatsApp pendant un redémarrage : gardés et traités — 31 octobre 2026

Décision d'Amine du 28/10 (EVT-3334, remplace D-B) : un message reçu pendant une mise à jour ou un redémarrage de Samantha est gardé, traité une fois qu'elle est prête, puis la réponse est envoyée.

Le 28/10, seule la pièce Pulse a été traitée. Un message d'Amine envoyé pendant un déploiement recevait encore la réponse d'échec du coordinateur (« rien n'a été exécuté »).

Changement :
- `handleOwnerFastPath` (tour d'Amine sur WhatsApp) applique la même attente bornée que la pièce Pulse : quand le coordinateur marque le tour `retryable` (fenêtre de maintenance fermée, ou interprétation jamais partie), le même événement est soumis à nouveau toutes les 5 s pendant 5 min au plus ;
- au-delà, la réponse est « Samantha redémarre encore : rien n'a été exécuté… » ;
- toute autre réponse est définitive : un vrai échec n'est jamais renvoyé ;
- la boucle passe dans `dialogueSurface.ts` (`dialogueTurnUntilReady`), partagée par les deux surfaces. Rien n'est dupliqué, et aucune file ni aucun moteur de relance n'est ajouté.

Le coordinateur reste seul juge. Il ne marque `retryable` que lorsqu'il n'a rien gardé et rien exécuté, et l'événement rejoué est le même (`eventRef` identique, idempotent).

Limites :
- l'app et la voix gardent leur comportement : une personne devant l'écran ou au téléphone n'attend pas 5 min ;
- un message qui n'atteint pas le plugin (passerelle elle-même arrêtée) dépend, comme avant, de la relivraison WhatsApp ;
- la preuve réelle sera un message envoyé pendant un déploiement puis répondu.

Retour arrière : revert.
