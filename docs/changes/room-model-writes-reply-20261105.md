# Pièces des contacts : le modèle rédige toutes les réponses (05/11/2026)

## Décision

Amine, 05/11 : « le modèle à l'entrée et à la sortie, pour tout », que ce soit pour Sadok ou pour n'importe quel autre contact, dans Pulse comme dans les autres pièces.

## Constat

S24, 05/11 à 09:54, pièce Pulse : la création de « Zain bh phase 6 » s'est arrêtée à l'équipe, après le projet 20933, sa phase et son commandé. Le reçu nommait les étapes faites et la cause. La pièce, elle, remettait la phrase de l'outil telle quelle (`canDeliverSourceReply`) : le tour s'arrêtait là, sans que le modèle rédige. Sadok n'a donc reçu que « La demande n'a pas abouti. Consulte le détail avant toute nouvelle action. ».

## Ce qui change

- `roomBrain.ts` n'utilise plus `canDeliverSourceReply`. Aucune réponse d'outil n'est remise sans passer par le modèle.
- Chaque résultat transmis au modèle contient l'état, la cause, les faits du reçu (y compris en cas d'échec) et la phrase du propriétaire en référence (`toolText`). Il porte la consigne de rédiger soi-même la réponse au contact à partir de ce résultat seulement : ce qui est fait, ce qui reste et pourquoi, sans rien ajouter de mémoire.
- Les règles des pièces (Pulse, Agenda, Actions, Messages) disent la même chose. Elles ne demandent plus de « remettre telles quelles » les réponses prêtes.
- La lecture de parcours au déploiement (`deploy-parcours-room.cjs`) lit `details.toolText`.

## Tests

- `test-pulse-room-brain.cjs` (84 vérifications) : nouveau cas tiré du partiel réel du 05/11. Les faits (projet 20933, étapes) arrivent au modèle, la consigne de rédaction est présente, aucune `sourceReply`. Même chose pour un refus. Le test échoue sur l'ancien code.
- `test-contact-room-brain.cjs` (98), `test-room-send-approval.cjs` (52), `test-recette-formulations.cjs` (70) : adaptés à `toolText`, verts.
- `test-deploy-parcours.py` : vert.

## Limites

- Les surfaces d'Amine (app, WhatsApp, chat) passent déjà par le modèle. La voix garde la consigne `voice.verbatim` (lire d'abord la phrase de compréhension ou d'échec) : elle est traitée à part.
- La qualité de la rédaction dépend du modèle de la pièce. Elle reste bornée aux faits du reçu.

## Retour arrière

Revert de ce commit, puis `companion-deploy.sh <commit>`.
