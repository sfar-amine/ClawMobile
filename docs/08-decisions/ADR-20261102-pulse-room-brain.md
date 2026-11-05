# ADR — cerveau du contact autorisé dans la pièce Pulse (02/11/2026)

## Décision (Amine, 02/11/2026)
« Un autorisé sur une pièce peut tout faire dedans. » Un contact WhatsApp autorisé sur la pièce Pulse (agents
`contacts-pulse` et `contacts-projet-pulse`) a la même expérience qu'Amine : son cerveau raisonne dans sa boucle
d'agent avec les outils typés de sa pièce (lire la demande, appeler `samantha_pulse`, lire le résultat, demander ou
agir, répondre).

Ce chemin **remplace** le service professionnel natif de la pièce (interception `before_dispatch`, un appel
d'interprète, puis le coordinateur déterministe). Il n'y a qu'un chemin : ni bascule par pièce, ni repli natif.
Cette décision remplace, pour la pièce Pulse seulement, le paragraphe « Les contacts Pulse gardent leur service
professionnel existant » de [ADR-20261026-pulse-scoped-brain](ADR-20261026-pulse-scoped-brain.md). Le reste de cet
ADR (cerveau propriétaire, outils typés propriétaires isolés des contacts) reste en vigueur.

## Ce qui ne change pas
- Les propriétaires : le Capability Graph, le coordinateur de dialogue et sa politique de portée `pulse_room`, la
  préparation Pulse (dry run), la confirmation liée, l'exécution de la commande préparée, sa relecture et sa
  vérification, le registre des contacts (people-trusted) et sa lecture de grant.
- Le compte Pulse utilisé reste celui d'Amine (décision `caller: owner` du Graph, comme la pièce native) ; d'où le
  refus de `leave.request`.
- Aucun nouveau store, registre, routeur, démon, retry ou planificateur.

## Ce qui change
- Le principal d'un appel de pièce est le contact (`room:pulse:wa-…`), jamais « owner » : preuve d'invocation
  `before_tool_call`, hôte privé du helper typé, admission Graph (`admit_room_invocation`) et hash de contrat.
- La portée est imposée par l'hôte et les propriétaires, jamais par le modèle : fabrique d'outils, politique d'outils
  de l'agent (`pulse-room.py`), preuve d'invocation, grant relu une fois par message et avant toute écriture,
  politique `pulse_room` du coordinateur.
- « Ne jamais inventer » : les réponses déjà rédigées par les propriétaires sont remises telles quelles
  (`canDeliverSourceReply`) ; une lecture qui ne rend que des faits vérifiés les donne au modèle avec la consigne de
  n'utiliser qu'eux.

## Point ouvert à confirmer par Amine
Les données Pulse lues pour un contact passent désormais par le modèle de l'agent du contact (même fournisseur et
même compte que le cerveau d'Amine, `agents.entries.contacts-*.model`), et non plus seulement par l'interprète
Gemini admis sous `pulse_interpretation`. La décision du 02/11 l'implique ; l'admission de données correspondante
(DATA01) doit être confirmée avant le déploiement.

## Extension à toutes les pièces des contacts (02/11/2026, étape 4 de « Le cerveau partout »)
Note : [contact-rooms-brain-20261102](../changes/contact-rooms-brain-20261102.md).

La même décision s'applique aux pièces agenda, actions et messages, seules ou combinées entre elles, avec Pulse ou
avec Projet : « Si quelqu'un est autorisé sur une pièce il peut tout faire dedans », dans le domaine de la pièce
seulement. Le mécanisme Pulse devient le mécanisme unique des pièces :
- un modèle (`contactRoomProfile.ts` `ROOM_TYPED`, playbooks `typed_tools.ROOM_DOMAINS`) :
  - `pulse` → `samantha_pulse` ;
  - `agenda` → `samantha_agenda` ;
  - `actions` → `samantha_device_assistance` ;
  - `messages` → `samantha_whatsapp` ;
- un principal `room:<pièce>:wa-…` ;
- une fabrique (`roomBrain.ts` `createRoomTools`) ;
- une garde (`capabilityAgentGuard.ts` `roomToolPrincipal`, `consumeRoomInvocation`) ;
- une politique d'outils d'agent (`project-room.py` `room_tool_policy`).

L'interception native `contactRoomFastPath.ts` (`before_dispatch`, réponses déterministes) est retirée, sans bascule
par pièce ni repli natif.

Ce qui reste fixé par le code, quelle que soit la demande :
- Le compte utilisé est celui d'Amine (décision `caller: owner`). Une écriture que le propriétaire récapitulerait
  (agenda, envoi WhatsApp) passe par la politique de pièce : commande préparée par l'hôte, arrêt au hand-off, grant
  relu sans cache, exécution unique, vérification, aucun rejeu.
- Les SMS et les photos d'Amine ne sont ouverts à aucune pièce (décision du 31/10) : refus nommé `scope_owner_private`.
- Paiement, banque et transaction sont refusés.
- `device.modes_routines` et la pièce `qa` n'ont pas de propriétaire typé. Aucun outil n'est donné et rien n'est
  exécuté (`room_domain_not_typed`). Aucune réponse n'est inventée.

Les données de la pièce passent par la session du modèle de l'agent du contact (DATA01, acceptée par Amine le 02/11
pour les pièces). Cette admission couvre aussi le point ouvert ci-dessus pour Pulse.

Réponses d'Amine (02/11) :
- **Agenda** : accès complet (lecture détaillée, création, modification), tel que livré.
- **Messages** : un envoi WhatsApp en son nom exige **sa confirmation pour chaque envoi**.
  - La commande préparée s'arrête à son hand-off. L'hôte de pièce ne la remet jamais.
  - Amine reçoit une demande de confirmation propriétaire : qui demande, destinataire, texte exact, avec confirmation
    biométrique ou refus. Elle passe par la confirmation propriétaire existante du Companion et l'écran
    `OwnerConfirmationActivity`.
  - Sur confirmation, la même commande est remise une fois, vérifiée et jamais rejouée. Sur refus ou expiration, elle
    est abandonnée.
  - Le contact reçoit « en attente de la confirmation d'Amine », puis l'issue.
- **QA** : propriétaire typé `samantha_qa` dans un lot séparé ; d'ici là, `room_domain_not_typed`.

## Révision du 05/11/2026 (Amine) : le modèle rédige toutes les réponses
« Le modèle à l'entrée et à la sortie, pour tout. » Le point « les réponses déjà rédigées par les propriétaires sont
remises telles quelles (`canDeliverSourceReply`) » est **retiré**, pour toutes les pièces des contacts.

Chaque résultat d'outil va au modèle : état, cause, faits vérifiés du reçu, et la phrase du propriétaire comme
référence (`toolText`). Le modèle rédige lui-même la réponse au contact, à partir de ce résultat seulement : ce qui est
fait, ce qui reste et pourquoi. Il n'ajoute rien de mémoire. Aucune réponse d'outil n'est remise au contact sans
passer par le modèle.

Cause : S24 05/11 09:54. La création du projet 20933 était partielle (projet, phase et commandé faits ; équipe non
faite, cause nommée). Elle est arrivée chez Sadok sous la forme du seul échec générique, remis sans passer par le
modèle. Note : [room-model-writes-reply-20261105](../changes/room-model-writes-reply-20261105.md).
