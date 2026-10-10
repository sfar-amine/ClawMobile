# O7 — Rendu télécom lisible et provenance bornée

Le rendu existant du fast path ne sérialise plus un résultat structuré dans le
texte de la réponse. Une carte télécom est une ligne : libellé, valeur exacte,
unité, puis validité restante si `days_remaining` est un entier fourni par le
propriétaire. Les cartes restent distinctes : aucune somme, conversion ou
échéance inventée. La projection lit `data.cards` (ou `cards`) du propriétaire
Maxit existant ; ses champs `title`/`label`, `value`, `unit`, `days_remaining`
sont confirmés dans le code canonique `telecom/maxit_direct.py` et ses tests.

Le rendu prend au plus 32 cartes, des libellés de 80 caractères et des unités
fermées. Une valeur non numérique, un champ manquant ou inattendu n'est pas
imprimé. Les autres objets/listes ont un repli générique lisible ; une chaîne
qui commence par `{` ou `[` n'est pas affichée comme réponse. Les lectures
composées sont bornées à 32 lignes, quatre niveaux, 128 nœuds et 8 000 caractères. Aucun compte, adresse,
URL, contexte de connexion ni JSON brut n'est repris à partir de ces objets.
Le texte libre réutilise le filtre `SENSITIVE` du propriétaire canonique
`context_import.py` (JWT, OTP, tokens…), avant troncature ; les montants
structurés des cartes ne passent pas dans son heuristique de chiffres.
Les contrôles ne sont pas des captures S24 et ne prétendent pas l'être.

## Provenance

Le reçu canonique porte uniquement `{capability, route, network_path?}`.
La route vient en priorité de `execution.actual_route` (A8), et non de la
route planifiée. Si ce champ est absent dans un ancien reçu, le seul repli est
`selected.route` ; c’est alors une provenance planifiée, pas une preuve de
route réellement suivie. Un `actual_route` présent mais invalide ne retombe
pas sur le plan et ne produit aucune provenance.
Les deux identifiants sont ASCII, au plus 160 caractères chacun, sans URL ou
adresse. `network_path` vaut exclusivement `wifi_off` ou
`cellular_bind_wifi_on`, lorsqu'il est fourni par l'exécution ou le payload
O1. Aucun champ `network_guard` complet, bail, SSID, réglage ou payload brut
n'est conservé dans la provenance.

`intent.ts` transmet cette projection au propriétaire `settleSubmittedRun`.
Le registre `runs.json` existant la conserve et la relit avec la même liste
fermée. Le statut la projette ; les cartes et valeurs brutes restent absentes
de ce champ. Aucun nouveau store. La rétention existante reste 500 runs et
8 Mio ; la projection ajoute moins de 400 octets par run. Le test initialise
10 000 runs et vérifie la rétention, la relecture ainsi que la préservation
des sections paiements et confirmations. Aucun parcours déterministe de
paiement ni état voix/O9 n'est modifié.

## Qualification et budget

La sortie huit cartes du 10/10 à 09:41 n'est pas présente dans les captures
publiées de la base bfa210c. La PR reste un brouillon en attendant cette preuve
nettoyée de Claude. La fixture historique copiée depuis
`telecom/maxit-direct-live-results.json` (playbooks 3862baa) est un vrai reçu
publié sans valeurs privées ; elle ne contient pas ces cartes. Elle sert
uniquement à vérifier le repli lisible, pas à prétendre qualifier les huit
cartes. La provenance de cette copie est publiée à côté du fichier.

Les cas de cartes et de volumes des tests sont des contrôles de forme/bornes,
explicitement distincts de la preuve manquante. Les tests sont inscrits dans
la CI. Aucune route HTTP n'est ajoutée, donc aucune recette fictive dans
`companion-acceptance.py`. Le budget du fast path n'est pas changé par O7 ;
O6 conserve sa responsabilité sur le budget du wrapper réseau. La projection
est locale, bornée et ne fait aucun appel Gateway.

Retour arrière : revert de la PR ; les champs additionnels sont optionnels.
Claude seul relit, fusionne, active et capture la recette S24.
