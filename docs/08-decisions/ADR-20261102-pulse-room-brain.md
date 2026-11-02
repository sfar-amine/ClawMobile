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
