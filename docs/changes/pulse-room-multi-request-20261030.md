# Pièce Pulse : les autres demandes d'un message non énuméré (30/10/2026)

Constat S24 du 30/10 : « liste les projets et les offres » répondait « Je n’ai pas compris ta demande Pulse… ».

Le correctif jumeau des playbooks garde dans la file du coordinateur les autres demandes trouvées par l'interprète. Il
les rend ensuite comme enfants du message (ordinal 2 et suivants), avec la même identité dérivée qu'une énumération.
Jusqu'ici, l'hôte de la pièce n'acceptait qu'un enfant égal à une ligne d'un message énuméré (« 1. … 2. … »).

Désormais, un seul contrôle partagé (`dialogueChildOrdinal`) sert à la reprise (`preservedRequests`) et à l'admission
native (`admitNativePulseContact`) :

- message énuméré : l'enfant est l'une de ses lignes, comme avant ;
- autre message : enfant d'ordinal 2 à 10 dont l'identité dérive exactement du parent, du texte et de l'ordinal.

Chaque enfant est réinterprété avec le message original, puis son périmètre est vérifié par le coordinateur. Quand la
première demande pose une question, la pièce dit qu'elle a gardé l'autre demande de ce message.
