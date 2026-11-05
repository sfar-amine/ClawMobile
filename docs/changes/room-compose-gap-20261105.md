# Pièce Pulse : Sol compose les actions existantes, et signale ce qui manque pour la fois suivante (05/11/2026)

## Pourquoi
Décision d'Amine du 05/11. Dans un cas limite, Sol doit avoir la liberté de faire « comme Claude » avec les actions de la pièce. Ce qu'il ne sait pas encore faire doit être codé pour le tour suivant, avec moins de contraintes. Jusqu'ici, une demande sans action exacte finissait par « vois avec Amine », et rien n'était enregistré.

## Ce qui change
- **Consigne de la pièce Pulse.** Si aucune action ne fait exactement ce que demande le contact, Sol compose avec les actions de l'outil, dans cet ordre :
  1. les lectures ;
  2. le plan, annoncé au contact ;
  3. chaque écriture, avec son propre accord.

  Si c'est impossible même ainsi, il appelle `lacune.signaler`, le dit franchement au contact sans promettre de délai, et propose ce qui est possible tout de suite.
- **Action `lacune.signaler`.** Elle n'existe que dans la pièce Pulse et suit la même admission qu'un appel normal.
  - Elle n'a que des champs fermés : les actions essayées (identifiants de cette pièce) et 1 à 5 codes de cause d'une liste fermée. Les mots du contact ne sont jamais transmis.
  - Elle part vers l'opération `gap` du propriétaire playbooks (`room_tool_turn`, pb#407). Celle-ci enregistre une observation dans le pool d'amélioration, et la boucle existante la transforme en route (PR, CI, fusion, activation).
  - Le modèle reçoit `GAP_RECORDED`, ou `room_gap_already_recorded` si la lacune est déjà enregistrée, et rédige la réponse.
- **Process projet.** L'équipe donnée s'ajoute toujours tout de suite (une affectation par personne). Le forecast de plusieurs personnes passe ensuite par `project.staffing` (pb, à venir) : un seul tableau mensuel confirmé pour toutes.

## Ordre d'activation
Playbooks d'abord (pb#407 pour `gap`, puis `project.staffing`), puis ce déploiement core. Sans pb#407, `lacune.signaler` reçoit le refus du propriétaire et ne dit jamais « enregistré ».
