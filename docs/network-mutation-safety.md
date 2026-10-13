# Temporary Android network mutation safety

## Purpose
Prevent temporary debugging or interception changes from outliving their task and breaking the S24 network.

## Contract
- Prefer app-scoped capture/VPN mechanisms over Android global proxy settings.
- A global proxy is never a casual discovery mechanism; use it only when the task explicitly requires it.
- Before any Claw-owned temporary network mutation, capture exact key presence and value.
- Restore an originally absent key with `settings delete`; never restore absence by writing the literal value `null`.
- A successful trap/cleanup command is not evidence of restoration. Re-read and compare the final state.
- Restoration is idempotent: settings already equal to the snapshot are not rewritten. Android's inactive proxy sentinels `http_proxy=:0` and `global_http_proxy_port=0` are treated as clean, not as an active unmanaged proxy. If an exact previously-empty setting would need to be recreated and Android shell cannot represent it safely, fail closed and retain the lease for verification rather than approximating the value.
- Verify an independent application-level network request after restoration.
- Never auto-remove an unmanaged proxy that Claw did not create.

## Guard
`installer/termux-lite/android-network-mutation-guard.py` owns temporary network-mutation leases.
It snapshots all Android global proxy keys before mutation and restores them exactly afterward. For `with-wifi-off`, the same lease also snapshots whether Wi‑Fi was enabled, disables Wi‑Fi only when necessary, and restores/verifies the exact initial Wi‑Fi state after the child command. A stale owned lease is automatically reconciled by the existing Health Manager loop, including Wi‑Fi restoration when the lease contains that snapshot.
An unmanaged proxy is reported as degraded rather than silently overwritten.

## Required checks
The guard covers:
- `http_proxy`
- `global_http_proxy_host`
- `global_http_proxy_port`
- `global_http_proxy_exclusion_list`
- `global_proxy_pac_url`

The health receipt is `~/.openclaw/health/network-mutation-safety.json`.
Health Manager treats a persistent failure as component `network_safety` and uses the existing incident lifecycle.

## Safe invocation
Use:
- proxy lease: `android-network-mutation-guard.py with-global-proxy HOST:PORT --purpose <reason> -- <command...>`
- temporary Wi‑Fi OFF: `android-network-mutation-guard.py with-wifi-off --purpose <reason> -- <command...>`

`with-wifi-off` is intended for workflows such as Orange/Maxit that require mobile-network execution. It does not change the default SIM or mobile-data setting and restores Wi‑Fi only to the state observed at entry.

## Canal cellulaire avec Wi-Fi actif

Le propriétaire `adb_forward` existant accepte aussi un endpoint Unix Termux strictement borné :
`localfilesystem:$PREFIX/tmp/samantha-cellular-<32 hex>.sock` vers
`localabstract:ai.samantha.cellular.<mêmes 32 hex>`. Le suffixe aléatoire doit être
strictement identique des deux côtés. Le répertoire `$PREFIX/tmp` doit déjà exister,
être un répertoire réel (aucun lien symbolique), appartenir à l'euid du garde et être
en mode `0700`. Tout autre nom, destination, parent ou pathname préexistant inattendu
est refusé avant l'appel ADB.

Le reçu expose l'endpoint sous la forme
`{"type":"unix","socket_path":"…"}`. L'état prêt exige à la fois l'observation exacte
du forward par `adb forward --list` et celle du socket Unix. Le bail mémorise l'identité
du socket créé. À la fermeture, le garde retire uniquement le forward exact puis ne
supprime le pathname que si cette identité est inchangée ; un remplacement externe est
préservé et place le bail en vérification. Si la réponse de création ADB est perdue après
l'effet, le garde ne récupère la propriété que pour ce type `localfilesystem`, lorsque
le snapshot antérieur était vide et que le mapping, le socket, son identité et le suffixe
unique concordent avec le bail durable `CREATE_REQUESTED`. Le réconciliateur peut alors
retirer cet effet après un crash. Le contrat TCP existant reste inchangé et conserve son
refus de déduire la propriété d'une réponse perdue.

## Wi‑Fi coupé : auto-réparation (incident S24 du 11/10, 16:00)

Constat : Wi‑Fi coupé 40 min, aucun garde vivant, `leases/` vide, `network_safety` resté sain (aucun bail à réconcilier). Cause la plus probable : deux gardes concurrents. Le second photographie « Wi‑Fi coupé » pendant que le premier le tient coupé. Le premier restaure. Le second voit le Wi‑Fi revenir, arrête son enfant et « restaure » l'état coupé, puis supprime son bail. Une mort du garde par délai du pont pendant la coupure produit le même symptôme côté utilisateur. Règle désormais : **la restauration du Wi‑Fi ne dépend jamais de la survie du garde.**

1. **Le Wi‑Fi n'est touché que s'il est le réseau par défaut connecté.** La décision vient de `dumpsys connectivity` (`Active default network` puis `Transports`), avec un repli sur `cmd wifi status` (« connected »). Wi‑Fi désactivé, ou activé sans connexion, ou réseau par défaut cellulaire : aucune mutation. L'enfant est lancé directement et le reçu porte `mutation: "none"`, `reason: "cellular_already_default"` et `network_decision`. Si le Wi‑Fi était déjà désactivé, la surveillance « Wi‑Fi revenu » reste active. La vérification de disponibilité mobile (connexion TCP vers `krakend-bff.maxit.orange.tn:443`) reste faite par les playbooks, dans l'enfant.
2. **Le garde sérialise via le `guard.lock` existant.** Sous ce verrou, il restaure d'abord tout bail `wifi_off` mort ou échu. Si un autre bail `wifi_off` est vivant, il refuse (`wifi_off_guard_busy`, code 5) sans aucune lecture ni mutation. Il n'y a donc jamais de second instantané « coupé ».
3. **Le bail est durable et borné.** Il réutilise le répertoire et le format existants (`~/.openclaw/network-mutation/leases/<id>.json`), avec une écriture atomique, un fsync du fichier et du répertoire, et les droits 600. Il contient : `purpose`, `owner_pid`, `owner_identity` (naissance et boot, contre la réutilisation d'un PID), `created_at`, `ttl_s`, `expires_at`, `wifi_enabled` (état antérieur), `auto_wifi`, `owner_token` et `network_decision`. Le TTL vaut `max(budget du motif, 120 s)`, plafonné à 600 s. Pour `maxit-topup-payment` et `maxit-deterministic`, le budget est de 60 s par appel fournisseur, soit un TTL de 120 s.
4. **Un restaurateur détaché est créé par bail.** Commande interne `wifi-restorer <bail> --token <jeton>` : `setsid`, double fork, signaux HUP, INT et TERM ignorés, entrées-sorties redirigées vers `/dev/null`. Il est hors du groupe, de la session et de l'arbre de processus du garde et du pont. Il sonde chaque seconde (lecture de `/proc` uniquement, aucun appel ADB). Si le bail disparaît (le garde a restauré), il se termine sans rien faire. Si le garde est mort ou que le TTL est échu, il restaure exactement depuis le bail, sous `guard.lock`. Il ne rallume le Wi‑Fi que si `wifi_enabled` était vrai. Il supprime ensuite le bail, écrit le reçu `wifi_lease_restored_by_restorer` et ajoute une ligne au `health.log`. Sans restaurateur, il n'y a pas de coupure : `wifi_restorer_unavailable`, code 6. Ce n'est pas un démon : la durée de vie est bornée par TTL + 6 tentatives.
5. **Le garde finit avant l'échéance.** L'enfant est arrêté à `TTL − 20 s` (`wifi_off_ttl_expired`, code 4), puis le garde restaure. Avec le budget de 60 s, ce cas n'arrive pas sur un parcours normal. À la sortie, si le bail a déjà été restauré par le restaurateur ou par le balayage, le garde ne touche à rien : pas de double bascule. Un second signal reçu pendant la restauration est ignoré.
6. **Le Health Manager sert de filet.** Son `check` (toutes les ~60 s) restaure tout bail dont le propriétaire est mort ou dont le TTL est échu, et journalise `action=stale_lease_restored` avec sa cause. Un **Wi‑Fi coupé sans bail n'est jamais réactivé**, car cela peut être un choix d'Amine. Il est seulement exposé : `warnings: ["wifi_disabled_without_lease"]` dans le reçu, une ligne `state=warning` dans `health.log` à chaque transition, et un avertissement non critique `device.network_safety.wifi_unmanaged` dans le verdict santé.

Le parcours de paiement n'est pas modifié. Les playbooks (`maxit_topup_payment`, `maxit_guarded_service`) appellent la même commande `with-wifi-off --purpose … -- …`, et leurs étapes, budgets et analyse de la dernière ligne sont inchangés. Seuls s'ajoutent des refus précoces sans effet (`wifi_off_guard_busy`, `wifi_restorer_unavailable`) et une borne de durée, `wifi_off_ttl_expired`, qui reste au-delà du budget fournisseur.

Do not issue raw `settings put global http_proxy ...` in Claw experiments.
For any other temporary system setting outside this helper, apply the same snapshot / exact-restore / post-check contract before mutation.
