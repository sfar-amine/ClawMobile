# Incident Orange vocal du 15/10 — la voix en direct ne coupe jamais le Wi-Fi

## Constat (S24, lecture seule)
Le 15/10 entre 21:23 et 22:11 UTC, cinq tours vocaux « mon solde Orange » (`clawmobile-companion/runs.json`) ont chacun obtenu leur lecture Maxit en moins d'une seconde (`telecom/runs.jsonl` : `orange.usage.maxit.v1`, `ok:true`, 21:24:00, 21:25:16, 21:27:11, 21:28:29, 22:10:48). Aucun n'a reçu de réponse : transcript `interrupted`, résultat vide, après 20 à 85 s d'attente. La même demande écrite à 21:27:38 a reçu la fiche complète en 8,7 s. Le garde de l'époque (`with-wifi-off`) coupait le Wi-Fi pour chaque consultation quand le Wi-Fi était le réseau par défaut (bail `wifi_off`, dernier mouvement du répertoire des baux à 22:10 UTC). La session Gemini Live du Companion, qui sortait par ce Wi-Fi, était perdue pendant le tour : la réponse n'était jamais dite et l'app restait en chargement.

Les correctifs déjà fusionnés (voix v2 #251/#252/#266, N2 #269, fiche complète #278/#280) ne touchent ni le garde réseau ni la perte de la session vocale : l'incident n'était pas couvert. La chaîne canal cellulaire (#112/#271/#267) évite la coupure dans le cas nominal (Wi-Fi principal avec cellule Orange qualifiée), mais son couloir `guarded_fallback` coupe encore le Wi-Fi.

## Correctif
`with-consultation-receipt --keep-wifi` : le garde n'accepte que les chemins cellulaires attestés (`cellular_default`, `cellular_bound_wifi_unchanged`). Si seul le couloir Wi-Fi coupé reste possible, il refuse avec `orange_cellular_required_wifi_kept` et la raison observée, sans bail, sans enfant ni appel fournisseur. La PR jumelle playbooks passe ce drapeau pour les surfaces vocales. Les autres surfaces et la recharge payante (`with-wifi-off`, qui refuse ce drapeau) sont inchangées. Conforme à la décision d'Amine du 17/10 « 4G et Wi-Fi ».

## Tests
`installer/termux-lite/test-consultation-voice-keep-wifi.py`, inscrit dans `ci.yml` : reproduction de l'incident (couloir Wi-Fi coupé en voix : aucun basculement, refus motivé, aucun bail ni enfant), chemins cellulaires attestés conservés, surfaces texte inchangées, drapeau absent du parcours paiement.

## Retour arrière
Revert de ce commit et de la PR jumelle playbooks ; sans le drapeau, le comportement est celui de #112.
