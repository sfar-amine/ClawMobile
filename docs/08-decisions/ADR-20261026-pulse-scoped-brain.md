# ADR — Pulse, cerveau dans un acteur de pièce existant

Le mode cerveau seul traite le message original dans le contexte du contact, jamais dans le contexte propriétaire. La preuve before_tool_call et la factory SDK existantes projettent le droit Pulse déjà accordé ; les propriétaires NativePulseContact, People et le passeport de pièce revalident ce droit, l’identité, le workspace et les instructions avant accès/effet. Le pipe privé ne crée pas un owner=true ni un droit depuis JSON. Les validations et confirmations métier restent aux propriétaires.

L’interprète professionnel antérieur reste seulement en mode false pour baseline/rollback. En mode true son purpose est refusé avant le runtime modèle. Les demandes en attente sont des observations du coordinateur, jamais un ordonnancement automatique pour le cerveau. Le mode legacy utilise la queue CAS existante, avec message original et références d’événements stables jusqu’à un résultat terminal exact.

La qualification DATA01/C2 du fournisseur, du compte et de toute la projection reste un prérequis distinct de l’octroi du droit Pulse ; coût gratuit et authentification ne la remplacent pas. Toute voie non qualifiée reste fermée avant inférence. Aucun nouveau routeur, store, hook sémantique, démon, retry ou calendrier n’est créé.

Validation : suites typées/room/port et propriétaires PB appariés, puis CI canonique de la tête combinée ; activation/recette séparées avec preuve native. Les ciblés authored n’attestent ni fournisseur réel ni donnée professionnelle transmise.
