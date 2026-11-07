# S24 07/11/2026 — solde Orange : l'app Max it d'abord, Wi-Fi gardé

Relevés en lecture seule sur le S24, le soir du 07/11/2026, puis messages d'Amine dans le chat du même soir.
Aucun numéro, solde, jeton ni identifiant de compte.

`app-session-evidence.json` :

- `guardReceipt2018` : à 20:18, le garde réseau (`android-network-mutation-guard.py with-consultation-receipt`) a pris le
  couloir `guarded_fallback` (raison `orange_cellular_not_ready` : Wi-Fi par défaut, aucune 4G Orange validée en
  parallèle). Preuve : `wifi_initial: true`, `wifi_disabled: true`, `dns_ready_ms: 3312`, `restored: true`.
- `defaultDataSubscription` : la souscription de données par défaut est la SIM Orange (sub id 1, opérateur Orange, LTE).
- `orangeApiOver4g` : l'API Orange a répondu `waaat_auth_failed` à 20:25 (3245 ms) et à 20:35 (2069 ms), sur 4G.
  L'échec a persisté même après la connexion d'Amine à Max it.
- `ownerObservation` : une fois connecté par la 4G, Amine voit son solde dans Max it sur Wi-Fi. Citation exacte du chat :
  « j'arrive a voir mon solde dans maxit et puisque cest moi qui a mis la 4g et loué a maxit donc j'ai eu le jeton donc
  tas plus besoin de swicher a chaque fois ».
- `ownerDecision` : décision d'Amine « App Max it d'abord ». Le Wi-Fi est gardé. La 4G (Wi-Fi coupé) ne sert qu'à se
  reconnecter à Max it (« Se connecter via réseau mobile ») ou quand l'écran est verrouillé (API Orange en 4G).
  Les codes `maxit_signed_out` et `screen_locked` sont les raisons du protocole garde/playbooks qui portent ces deux cas.

Utilisée par `installer/termux-lite/test-consultation-app-session-first.py`. Le test reprend la preuve réelle de 20:18
comme résultat attendu de la phase B (escalade vers le couloir Wi-Fi coupé), et la raison réelle
`orange_cellular_not_ready` comme décision de départ de la phase A (lecture de l'app, Wi-Fi inchangé).
