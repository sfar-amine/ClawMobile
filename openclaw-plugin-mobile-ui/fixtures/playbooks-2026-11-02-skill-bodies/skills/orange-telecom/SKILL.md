---
name: orange-telecom
description: Consult Orange Maxit, Tunisie Telecom and validated Zain Bahrain read-only account states through the shared deterministic telecom service.
---
# Télécom — Orange / Maxit, Tunisie Telecom et Zain Bahrain
Concerne uniquement les demandes du propriétaire. Appeler d'abord l'outil typé de l'opérateur (`samantha_maxit_tunisie` pour Orange, `samantha_tunisie_telecom` pour TT, `samantha_zain_bahrain` pour Zain ; présent dans tes outils ; sinon `tool_search` avec une seule `query`, jamais de `limit` au niveau d'un lot `queries`) : il porte la route, le repli et le reçu. Ne lire `ui-playbooks/telecom/ROUTING.md` et le catalogue que si aucun outil typé ne couvre la demande ; ne pas refaire de recherche web pour une demande connue.

## Choix du parcours
- Orange : recharge → `recharge`, tous compteurs → `balances`, offre → `offer`, numéro → `phone_number`, Data → `data`, voix → `voice`, consommation → `usage`, codes → `tracking_codes`.
- TT : principal → `principal`, soldes/bonus → `balances`, internet → `data`, offre → `offer`, numéro → `phone_number`, codes → `tracking_codes`.
- Zain Bahrain : solde affiché → `balance`, état/validité → `line_status`, ligne sélectionnée → `line_identity`, bundle actif/inactif → `bundle_status`.
- Pour Orange/TT, « solde » sans compteur précis → `balances` : toutes les cartes, séparément, sans question préalable (S24 28/10 : la question « quel solde ? » retardait une lecture déjà complète). Ne pas additionner les comptes.

## Exécution (repli sans outil typé)
Seulement si aucun outil typé n'est disponible ; depuis le runtime épinglé, jamais le checkout `workspace/ui-playbooks`, qui peut retarder sur la version active.
```sh
cd /data/data/com.termux/files/home/.openclaw/runtime-ui-playbooks/current
python -m telecom.maxit_guarded_service data --mode auto
python -m telecom.service read zain balance --mode auto
```
Le mode `auto` suit le meilleur parcours validé de l'opérateur. Orange/TT privilégient les routes silencieuses disponibles. Zain utilise actuellement sa route visible Home; `silent` y bloque avant toute UI. `ui` force uniquement un parcours visible connu.
Pour toute consultation Orange/Maxit, utiliser l'entrée `telecom.maxit_guarded_service`: elle snapshotte l'état Wi‑Fi via le Network Mutation Guard canonique, coupe temporairement le Wi‑Fi lorsqu'il était actif, exécute le parcours Orange sur le réseau mobile, puis restaure et vérifie exactement l'état initial. Si le Wi‑Fi était déjà coupé, il reste coupé. Toute action Maxit transactionnelle explicitement demandée par le propriétaire doit quitter cette capability de consultation et déléguer à `payment.owner_native`. La route d'action conserve le Network Mutation Guard requis, sa confirmation propriétaire native et ses propres gates; ne jamais transformer cette délégation en refus générique de paiement. Cette règle n'est pas appliquée à Zain ou TT.
Lire `ok`, `source`, `transport`, `observed_at` et `data`. Une erreur n'est pas un zéro ; ne jamais réutiliser une ancienne valeur comme actuelle.

## Orange Maxit Direct
Priorité 1 silencieuse pour `phone_number`, `offer`, `recharge`, `data`, `voice`, `usage`. Deux campagnes fresh-process et les shadows indépendants sont validés. Ne pas ouvrir Maxit ou USSD si Direct réussit.
`balance`, `solde` et `balances` retournent la projection complète `usage`, équivalente à **Ma ligne → Mon suivi conso → Voir tout**. Retourner toutes les cartes séparément, avec unité et échéance ; ne pas les sommer. En `auto`, fallback vers la même page Maxit (`orange.usage.ui.v1`), jamais vers l'USSD générique. Les intentions distinctes non exposées par la page conservent leurs routes ciblées. `tracking_codes` reste sur le portail USSD validé et automatisé.
`forfait_bonus` et `loyalty_calls` restent natifs silencieux. Voir `ui-playbooks/telecom/MAXIT_DIRECT.md`.

## Tunisie Telecom
Les lectures TT restent nativement authentifiées par la SIM `TUNTEL` via `android_sendUssdRequest`; aucun credential n'est requis dans Claw. My TT documente login/mot de passe ou inscription numéro + code SMS. Une éventuelle auto-auth par data TT reste une candidate à prouver en shadow avant tout basculement de SIM data dans le chemin nominal. Si elle est validée plus tard, la restauration de la préférence data Orange initiale sera obligatoire et vérifiée.

## Zain Bahrain
`balance`, `line_status`, `line_identity` et `bundle_status` utilisent `zain_accessibility_home`. Trois rounds froids ont validé la route. `usage/data/voice` ne sont pas validés avec un bundle actif et doivent échouer fermé dans ce cas. Voir `ui-playbooks/telecom/ZAIN_BAHRAIN.md`.

## Benchmark E2E
`python -m telecom.benchmark maxit --runs 3` mesure les use cases Maxit classiques du lancement de l'entrée canonique au résultat terminal. `python -m telecom.benchmark tt --runs 3` fait de même pour TT. Les résultats ne conservent jamais les valeurs de compte : uniquement succès, route/source, fallback, usage UI et latences wall-clock p50/p95.

## Résilience
Si Direct échoue en `auto`, utiliser uniquement le fallback priorité 2 déjà validé. En `silent`, ne jamais ouvrir l'UI. Ne pas inventer une valeur depuis une erreur ou une projection incomplète.
La reprise ADB bornée concerne les lectures natives ; ne pas la doubler. `indeterminate_no_retry` n'est jamais rejoué.

## Garde-fous
Cette capability de consultation reste read-only : elle n'exécute ni achat, ni transfert, ni changement d'offre. Lorsqu'une demande owner correspond à une action transactionnelle couverte par une capability dédiée validée (notamment `payment.owner_native` pour une recharge Maxit propre numéro), déléguer à cette capability et à sa confirmation biométrique au lieu de répondre que les paiements/recharges sont interdits. Les actions sans route transactionnelle validée restent fail-closed. Ne conserver aucune réponse de compte, numéro ou état d'autorisation temporaire dans Git ou la mémoire commune.
