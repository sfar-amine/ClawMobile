# Garde Wi‑Fi coupé auto-réparant — 11/10/2026

## Incident
- S24, 11/10 vers 16:00 (heure locale) : Wi‑Fi coupé pendant 40 min, réactivé à la main par Claude.
- Aucun garde vivant ; `~/.openclaw/network-mutation/leases/` vide.
- `health.log` : `network_safety` jamais dégradé entre 15:37 et 16:47. Le balayage n'avait donc aucun bail à réconcilier.
- Lecture seule sur le S24 : le garde déployé (`7c5cddc5`, sha256 `60ab7d54…`) est identique à celui de la branche `runtime/samantha-companion-private`.
- Cause la plus probable : un second garde concurrent a photographié « Wi‑Fi coupé » puis l'a « restauré ». Une mort du garde pendant la coupure donne le même symptôme.

## Changement
- Bail `wifi_off` durable et borné (`ttl_s` = max(budget, 120 s), plafonné à 600 s ; `expires_at`, `owner_token`, `owner_identity`), dans le répertoire et le format existants.
- Restaurateur détaché par bail (`wifi-restorer`, setsid + double fork). Il restaure si le garde est mort ou si le TTL est échu, et ne fait rien si le garde a déjà restauré.
- Sérialisation par le `guard.lock` existant : un garde concurrent est refusé (`wifi_off_guard_busy`) sans lecture ni mutation.
- Le Wi‑Fi n'est coupé que s'il est le réseau par défaut connecté. En 4G, ou si le Wi‑Fi est désactivé ou non connecté, rien ne change, et le reçu porte `mutation: "none"`, `reason: "cellular_already_default"` (demande d'Amine, 11/10).
- Health Manager : restauration des baux morts ou échus, journalisée. Un Wi‑Fi coupé sans bail est signalé (reçu, `health.log`, verdict non critique), jamais réactivé.

## Parcours de paiement
**Inchangé.** Les appelants (`maxit_topup_payment`, `maxit_guarded_service`) gardent la même commande, les mêmes étapes, les mêmes budgets et la même analyse de la dernière ligne. Seuls s'ajoutent :
- des refus précoces sans effet ;
- une borne `wifi_off_ttl_expired` à TTL − 20 s = 100 s, au-delà du budget fournisseur de 60 s.

## Tests
`installer/termux-lite/test-android-network-mutation-guard.py` : WifiRestorerTests, DetachedRestorerProcessTest (vrai processus détaché et faux `adb`), HealthManagerSweepContractTest, CellularDefaultTests (fixtures S24 réelles `s24-2026-10-11/android/`). Plus `test-health-verdict.py`. Les deux sont inscrits dans la CI.

## Retour arrière
Revert du commit. Les baux schema 2 restent lisibles par l'ancien garde, qui ignore les champs ajoutés. Le déploiement sur le S24 reste fait par Claude via `companion-deploy.sh`.
