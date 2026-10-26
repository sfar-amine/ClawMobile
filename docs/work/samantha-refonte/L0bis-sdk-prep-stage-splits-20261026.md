# L0bis — attribution de la préparation, instrumentation transitoire

La recette APP native unique du 26/10, corrélée à son run/session SDK exacts,
prouve 16627ms de préparation jusqu'à stream-ready. `openclaw-tools:plugin-tools`
coûte11154ms, tandis que les53factories coûtent16ms au total (maximum montré2ms).
Le system-prompt coûte3496ms. Un tour modèle sans outil termine en2800ms depuis
prompt.submitted ; la mise à jour terminale locale suit session.ended de319ms.
Le délai tap→réservation12472ms reste un intervalle distinct non attribué.
La fixture et ses reçus hashés conservent ces frontières ; il ne s'agit pas d'un
nouveau benchmark ni d'une preuve de première réponse utile UI.

La source montre plusieurs opérations avant le timer factory : préparation du
contexte et de la livraison, auth lookup, sélection du contexte préparé, load-state,
résolution des owners/artifacts, éventuellement chargement du registre. Le journal
`[plugins] loaded …` n'est émis que si des imports sont tentés. Son absence ne
prouve pas que ces autres opérations sont gratuites. `tools.catalog` avec plugins
charge aussi le registre et appelle les factories ; il n'est pas manifest-only.
Remplacer ce préchauffage, ou cacher des outils liés à l'autorité du tour, serait
une correction non étayée à ce stade.

Le patch-set `gateway-prep-stages` ajoute11checkpoints fermés au
`recordToolPrepStage` existant et transmet ce callback au resolver plugins.
Il ajoute aussi huit sous-spans explicites du system-prompt via
`prepStages.measure/measureSync` existants : directory, runtime-context, références,
contribution fournisseur, mémoire, mémoire projet conditionnelle, assemblage et
rapport. Ces mesures **n'avancent pas le checkpoint previousAt** du tracker :
le `mark("system-prompt")` original conserve son aggregate comparable. Les
sous-spans et cet aggregate se recouvrent et ne doivent jamais être additionnés.
Le tracker `Date.now`, le logger, ses seuils, ses bornes et sa rétention restent
ceux du SDK. Aucun nouveau chrono, profiler, store, route, logger, cache, outil,
permission ou primitive MCP. Les durées/elapsedMs restent dans leur domaine de
temps existant ; pas de mélange avec `performance.now` du Companion.

Bornes ajoutées :

| Checkpoint | Opérations depuis la borne précédente |
| --- | --- |
| `plugin-tools:input-context` | runtimeConfig et inputs |
| `plugin-tools:delivery-context` | identité requester et liaison livraison |
| `plugin-tools:auth-lookup` | construction du lookup d'auth, sans lecture/export ajouté |
| `plugin-tools:prepared-context` | closures et sélection contexte/registre/caller courant |
| `plugin-tools:load-state` | résolution load-state, snapshot et sélection plugins |
| `plugin-tools:registry-context` | contexte des owners et lookup manifests |
| `plugin-tools:runtime-owners` | correspondance instances/artifacts et owners manquants |
| `plugin-tools:registry-loaded` ou `plugin-tools:registry-reused` | chargement conditionnel, ou branche sans chargement |
| `plugin-tools:registrations` | projection des registrations détenues |
| `plugin-tools:factories` | résolution factories, filtres d'autorité et rapport existant |
| `plugin-tools:resolved` | retour au propriétaire appelant |

Les trois programmes complets sont épinglés aux SHA natifs qualifiés :

| Module | Original → patched |
| --- | --- |
| `openclaw-tools-thu-J91q.mjs` | `313924b5de456a7eb532e4e1921af14092f15b63aa7cfa63b4bbf9f03ef8eb5a` → `fa5ed7e15d5eb62dcc080b1f8acd78f14ad456d3142b62d4b7bb48e5aaf968da` |
| `tools-CvXdkvXK.mjs` | `a31975686eddc6a779865ff896b145b3b41bd7c659ac21761448da6861b0d926` → `c1793daf1edf51efd09fc7c0114ae19d85c8809c70132b8c76e74854d4b29b2d` |
| `builtin-openclaw-q1hiFm14.mjs` | `e4504516aef56cd293e11369e420148c5ad60c80e60128ed64bfb57fb7239e25` → `00f82ec9ee37d9394c05d50f7950d671db1c70d2358dea817e2ec6167aa1951d` |

Le propriétaire `whatsapp-network-recovery.py` prévalide version et tous les
hashes avant la première écriture, verrouille sa transaction, refuse symlinks et
états inconnus, puis écrit atomiquement. Son support des predecessors et les
autres ensembles ne changent pas. Un nouvel enum sélectionne seulement ce
manifeste disjoint des trois modules native-turn-provenance L3/L4 et de tous les
autres manifestes du propriétaire, y compris agent-exec-auth-scope.

## Activation minimale après CI canonique verte, par root

Cette option ne déploie pas la tête Companion contenant L3/L4 : elle applique
uniquement la compatibilité de diagnostic approuvée, par le propriétaire SDK
existant. Ni foundation ni BRAIN_ONLY ni native-turn-provenance ne sont activés.
Le set n'est volontairement appelé par aucun hook automatique de démarrage ou
de déploiement : la recette reste une intervention ponctuelle et réversible.

1. Relire contexte, claw_status de l'action stable, M3, SHA runtime, version SDK et
   PID réels. SDK quiet preflight existant vert, aucune recette/job concurrent ni
   effet incertain en cours. Conserver la recette physique et les versions actuelles.
2. Depuis le commit exact qualifié/publié, stager dans le dossier acceptance
   existant les seuls `whatsapp-network-recovery.py` et `gateway-prep-stages.json`.
   Vérifier leurs SHA de livraison. Garder propriétaire, manifeste, reçu et
   rollback ensemble. Aucune copie de configuration ou auth.
3. Commandes du même propriétaire (le root OpenClaw exact est d'abord confirmé) :

   ```sh
   python3 "$recipe/whatsapp-network-recovery.py" --patch-set gateway-prep-stages \
     --openclaw-root "$openclaw_root" --apply
   python3 "$recipe/whatsapp-network-recovery.py" --patch-set gateway-prep-stages \
     --openclaw-root "$openclaw_root" --check
   ```

4. Redémarrer par le propriétaire Gateway déjà déployé, jamais kill/restart ad hoc :

   ```sh
   node "$plugin/dist/companion/openclawGatewayClient.js" --deploy-restart \
     "$core/installer/termux-lite/runtime_mode.py"
   ```

   Les chemins plugin/core sont ceux relus du runtime en place, pas le checkout
   candidat. Ce CLI utilise le verrou/lease de réparation existant. Ne pas
   l'envelopper dans un second verrou EX indépendant qui bloquerait son propre
   propriétaire. Refus/timeout : relire état initial, jamais rejeu aveugle.
5. Vérifier nouveau PID/startTicks, gateway ready/soak, trois hashes SDK patched, pins
   Companion/PB inchangés, flags métier inchangés. Ni commit ni patch fichier ne
   prouvent à eux seuls le chargement effectif dans le processus.
6. Root conduit la recette publique isolée sous les owners existants. Les résumés
   lents utilisent le seuil warn existant ; les petits spans requièrent trace selon
   la recette one-shot déjà testée. Sa restauration CAS reste obligatoire. Export
   seulement des noms de checkpoints fixes et nombres corrélés ; jamais log brut.

Retour arrière par les **mêmes** bytes du propriétaire/manifeste :

```sh
python3 "$recipe/whatsapp-network-recovery.py" --patch-set gateway-prep-stages \
  --openclaw-root "$openclaw_root" --rollback
node "$plugin/dist/companion/openclawGatewayClient.js" --deploy-restart \
  "$core/installer/termux-lite/runtime_mode.py"
```

Vérifier les trois SHA originaux et un nouveau PID ready, sans revenir sur une
configuration ou une autorité métier. Toute dérive de module inconnue est refusée,
pas écrasée. Conserver les preuves d'incertitude et inspecter l'action originale.

## Vérification et portée

`test-gateway-prep-stages.py`, inscrit en CI dans cette PR, couvre le set complet
capturé, application/check/idempotence/rollback, dérive tardive sans première
écriture, version inconnue et symlink, puis les fonctions originales/patched via
VM et dépendances inertes : mêmes retours/effets/erreurs, callbacks optionnels,
branches registre déjà détenu/chargement, early return, propagation des labels.
Chaque module complet patched est aussi vérifié par le parseur Node, sans imports.
La fonction exacte de préparation system-prompt est exécutée en VM avec des
propriétaires inertes (seule import.meta.url reçoit une URL fixture publique).
Le tracker public exact vérifie qu'une aggregate artificielle de85ms reste85ms
avant/après, même avec81ms de sous-spans explicites. Les appels, résultats et
erreurs restent identiques, y compris exception runtime et finalisation spéciale.

Le ciblé et la CI canonique finale restent à exécuter ; aucun gain ou PASS S24
n'est anticipé. Cette livraison corrige le trou de diagnostic, pas encore le coût
sous-jacent. La mesure suivante doit nommer le propriétaire coûteux avant un
correctif de performance. La cause du system-prompt et le délai avant réservation
restent distincts et ouverts ; leurs durées ne sont pas attribuées à un fournisseur.

**NO_CAPABILITY** : ensemble ponctuel du propriétaire privé de compatibilité SDK,
sans nouvelle route HTTP ou MCP, réglage de l'app, action agent/voix ou admission
métier. Parité des six outils MCP, schémas, adapters et frontières de paiement
inchangée ; aucun appel modèle ou fournisseur payant ajouté.
