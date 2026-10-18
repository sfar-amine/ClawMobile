# Claw Live : la voix garde la confiance de la décision

**Problème.** Au banc voix du S24 (18/10, 22:13), même avec les playbooks `a4c60d93`, chaque lecture Orange sûre commençait encore par « J'ai compris : Solde et compteurs · Orange. ».

**Cause.** Le speaker de reçu n'annonce « J'ai compris : … » que sous le seuil de confiance (0,6), ou quand la confiance manque. `clawLiveCapabilityTurn` renvoyait `publicDecision(turn.decision)`. Cette projection publique n'a pas de champ `confidence` : la valeur perdue, toute lecture était annoncée. Playbooks #220 garde la confiance dans la réponse du coordinateur ; il fallait aussi la garder ici.

**Correctif.** `clawLive.ts` renvoie la décision publique et, à côté, la confiance du Graph, mais seulement si c'est un nombre fini entre 0 et 1. Les autres projections, le type `PublicDecision` et les routes restent inchangés.

**Tests.** `scripts/test-voice-understanding.cjs` (24/24) se fonde sur la décision Orange réelle du S24 (fixture `o7-o8-orange-20261010-0941`, confiance 1) :
- confiance 1 : rien n'est annoncé ;
- confiance 0,5 : l'annonce reste ;
- confiance NaN, 2 ou "1" : la valeur est écartée et l'annonce reste.

Sans le correctif, le test échoue.

**Recette.** Après déploiement, au banc voix S24 : « Quel est mon solde Orange ? » doit être lu sans « J'ai compris ».

**Retour arrière.** Revert de cette PR.
