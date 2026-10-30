# Cerveau : outils typés fréquents visibles directement — 30 octobre 2026

Trace S24 du 30/10 (21:21, `SAMANTHA_BRAIN_ONLY=1`, core 799306da), « Quel est l'état de mes factures », run `run_1793395301758_9b29ce1e` :
1. `read` du skill factures ;
2. `tool_search` en lot avec `limit` au niveau du lot : le SDK refuse (« set limit on each batch query, not on the batch request »), un tour modèle perdu ;
3. `exec` de la commande shell des factures (10,6 s) au lieu de l'outil typé `samantha_utility_billing`.

## Cause

`tools.toolSearch` n'est pas réglé dans `openclaw.json` : le SDK 2026.9.6 applique son mode par défaut `tools`. Les 110 outils, dont les 13 outils typés Samantha, passent derrière `tool_search` / `tool_describe` / `tool_call`. Seuls les primitives de code (`read`, `exec`…) et les outils marqués `catalogMode: "direct-only"` restent visibles. Le schéma de `tool_search` accepte un `limit` au niveau de la requête pour une recherche simple : le modèle l'a mis sur un lot `queries`, que le SDK refuse.

## Changement

`createTypedCapabilityTools` marque `catalogMode: "direct-only"` sur les outils typés fréquents :
- factures : `samantha_utility_billing`, `samantha_steg`, `samantha_sonede`, `samantha_topnet` ;
- ligne Orange : `samantha_maxit_tunisie` ;
- `samantha_agenda` et `samantha_pulse` ;
- `samantha_catalogue`.

C'est le réglage par outil documenté par le SDK (`AnyAgentTool.catalogMode`, `docs/tools/tool-search.md`) : le schéma reste visible et sort du catalogue. Aucun patch OpenClaw, aucune clé de configuration. Les autres outils typés restent derrière `tool_search`. Exécution, garde `before_tool_call`, admission et confirmations sont inchangées.

Coût du prompt : 27 493 caractères de schémas et descriptions visibles en plus (borne testée : 30 000), dans le préfixe stable mis en cache.

## Mesure (test)

`scripts/test-typed-tools-direct-visible.cjs` exécute les fonctions exactes du module public du SDK, identique octet pour octet au fichier du S24 :
- l'appel `tool_search` capturé échoue avec l'erreur du S24 ;
- avant : aucun outil typé n'est visible et les 14 sont catalogués ;
- après : les 8 outils fréquents sont visibles, les 6 autres restent catalogués ;
- une question factures fait un seul appel typé, `samantha_utility_billing` / `billing.unpaid`, et le propriétaire est invoqué une seule fois.

## Constats non traités ici

- Préparation avant le premier appel modèle : environ 9 s (accepté 21:21:42.9 → prompt 21:21:52.1), dont 4,3 s jusqu'au préflight (21:21:47.2) et 3,3 s entre le catalogue Tool Search (21:21:48.5) et le streamFn (21:21:51.8). Tâche existante « démarrage à froid ».
- `progress_card` est un outil du cœur OpenClaw, toujours derrière `tool_search`. Les skills des playbooks disent maintenant : une seule `query`, jamais de `limit` au niveau d'un lot.
- Topnet `ok:false` : maintenance réelle de « Mon Espace » chez Topnet. La commande shell tournait depuis un ancien checkout `workspace/ui-playbooks` (68fd7b02), qui la classait `login_form_changed`. Le runtime épinglé, utilisé par l'outil typé, la classe `provider_maintenance`. Correctif du skill dans la PR jumelle des playbooks.

## Retour arrière

Revert de cette PR, puis `companion-deploy.sh` du commit précédent. Les outils retournent derrière `tool_search`.
