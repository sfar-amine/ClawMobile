# Ouverture de session : le premier tour ne recharge plus le plugin WhatsApp — 2026-11-02

## Constat (S24, OpenClaw 2026.10.9, Node 24.22.2, lecture seule du 31/10 au 02/11)

Sources : journal Gateway (`companion-openclaw-gateway.log` et ses trois rotations), journal Companion
(`[voice-stages]`), `openclaw-agent.sqlite` de `main` (`session_nodes`, `transcript_events`) et `dialogue.sqlite`.

Tours propriétaire sur les trois jours :
- 46 tours de l'app (relais voix, sessions `companion-chat-samantha-*`, tous le 31/10) ;
- aucun tour WhatsApp du propriétaire (la session `whatsapp:direct` ne reçoit que des notifications) ;
- les autres runs sont des recettes de déploiement et la préchauffe `brain-warm`.

Délais des tours de l'app, de la requête `agent` à l'ouverture de la session (`run_started`) :
- médiane 2,4 s, p90 8,3 s, maximum 13,3 s ;
- le premier tour d'une nouvelle session coûte 7 à 13 s : écriture de session et vérification d'intégrité SQLite
  (4 à 8 s avant le run), puis 2 à 5,5 s de préparation ;
- côté Companion, la requête part 0,5 à 1,4 s après la fin de parole (`sent_ms`).

Aucune attente de voie : aucun `lane dequeue` au-dessus de 1 ms sur les trois jours. SQLite : au plus 1,7 s
(`cron.history-maintenance`) et 5 s de reprise dans un worker, hors des fenêtres longues.

Les longues attentes viennent toutes du **premier run après un démarrage de la Gateway ou un rechargement de
configuration**. Ce run construit son registre d'outils de plugins (`openclaw-tools:plugin-tools`). Le seul module
de ce registre qui n'est pas partagé est `@openclaw/whatsapp` (Baileys, environ 60 Mo de dépendances). Il est
réimporté de façon synchrone, sur le fil principal, pour deux outils que le tour du propriétaire n'utilise pas :
- `whatsapp_call` : la fabrique renvoie `null` à chaque run (« plugin tool factory returned null ») ;
- `whatsapp_login` : connexion du canal par QR, une étape humaine.

| Premier run | `loading whatsapp` | Début du run → session ouverte | Contexte |
| --- | --- | --- | --- |
| 31/10 23:08 (brain-warm) | 6,9 s | 12,2 s | nuit, après redémarrage |
| 01/11 23:23 (brain-warm) | 14,8 s | 18,9 s | déploiement, 26 tâches en retard regroupées, git/npm/node |
| 02/11 16:15 (brain-warm) | 14,2 s | 20,5 s | déploiement 653b3942, préchauffes de démarrage |
| 02/11 16:25 (recette) | **29,7 s** | **32,5 s** | 3 min après le rechargement à chaud de `agents.entries.main.tools` |

Les **45 s avant l'ouverture de session** sont la recette du 02/11. Elle démarre à 16:25:03 et sa session s'ouvre
à 16:25:48,4, soit 45,4 s :
- 8,4 s de démarrage du CLI `openclaw agent`, propre à la recette ;
- 0,6 s d'acceptation de la requête ;
- 3,8 s avant le run ;
- 30,5 s d'outils de plugins, dont 29,7 s de `loading whatsapp` ;
- 2,0 s pour le reste de la préparation.

Le premier événement du modèle arrive 2,7 s plus tard. Pendant le chargement, toute la Gateway est figée
(« liveness heartbeat delayed … elapsed=46180ms »). La connexion WhatsApp tombe juste après (408). Un tour arrivé
pendant ce temps attend aussi.

Témoin : le tour suivant de la même session, à 16:26:58, sans chargement, ouvre sa session en 2,1 s. La trace
détaillée du 31/10 (`plugin-tools:registry-loaded:6877ms`, `plugin-tools:factories:31ms`) montre que le temps est le
chargement du registre, pas nos fabriques d'outils.

La durée du chargement est multipliée par plus de 4 sous charge concurrente : déploiement, tâches regroupées et
rechargement à chaud. Le rechargement à chaud du 02/11 à 16:22 (après `model-efficiency-config.py --apply` de #126)
a lui-même rechargé les 13 plugins en 18,5 s (Gateway figée 38,5 s), puis invalidé le registre d'outils.

Les hooks `before_dispatch`, `inbound_claim` et `before_prompt_build` du plugin ne sont pas en cause : 31 ms de
fabriques, environ 0,3 s pour `before_prompt_build`. Le profil de modèle n'est pas en cause non plus.

## Changement

`installer/termux-lite/model-efficiency-config.py`, propriétaire existant de `agents.entries.*` : `whatsapp_call` et
`whatsapp_login` sont ajoutés à `agents.entries.main.tools.deny`.
- La fusion se fait avec la politique existante : rien n'est retiré, l'ordre est gardé, et une politique non conforme
  n'est pas réécrite.
- OpenClaw 2026.10.9 ne retient un plugin pour ce registre que si l'un des outils de son manifeste survit au refus
  (`tools-DQdRObqo.mjs`, `resolvePluginToolPluginIds`). Les deux noms forment tout le contrat d'outils du plugin
  WhatsApp : le module n'est donc plus importé au premier tour. Un seul des deux noms ne suffit pas, et le test le
  vérifie.
- Le canal WhatsApp lui-même (réception, envoi, notifications) est chargé par la Gateway et ne change pas.
- Les outils Samantha (`openclaw-plugin-mobile-ui`) restent tous proposés au modèle.
- Les agents contacts ont une liste `allow` explicite et ne chargent pas ce module : ils ne changent pas.
- Rien dans `src/index.ts` ni dans les hooks : les chemins historiques `before_dispatch` et `inbound_claim` ne sont pas
  la cause.

## Gain attendu et risque

Gain attendu : le premier tour après un redémarrage ou un rechargement perd 7 à 30 s avant l'ouverture de session.
Sur les quatre runs capturés, il reste 2,8 à 6,2 s entre le début du run et l'ouverture de la session. La Gateway ne
se fige plus pendant ce temps, pour aucune surface. La préchauffe du déploiement devient plus courte d'autant.

Sont inchangés :
- le coût d'une nouvelle session (SQLite) ;
- le double chargement des 13 plugins au démarrage de la Gateway (interne à OpenClaw) ;
- le temps passé dans le modèle.

Risque :
- l'agent `main` ne peut plus lancer lui-même la connexion WhatsApp par QR ; aucune capability ni aucun skill ne
  l'utilise (`git grep`) ;
- appliquer le changement modifie `openclaw.json`. Un rechargement à chaud recharge les 13 plugins et fige la Gateway
  environ 20 à 40 s, une seule fois. Il faut donc l'appliquer dans une fenêtre de déploiement (préflight sans job lourd),
  suivi d'un redémarrage propre de la Gateway, comme pour #126, et non pendant que le propriétaire parle à Samantha.

## Tests

- `installer/termux-lite/test-session-open-plugin-tools.py`, inscrit en CI :
  - il exécute les corps publics exacts d'OpenClaw 2026.10.9 (fixtures npm vérifiées par sha256) sur le manifeste
    WhatsApp capturé et sur la politique `main` du S24 ;
  - il rejoue les latences réelles du journal Gateway capturé, avec des budgets de 7 s entre le début du run et
    l'ouverture de session, et de 20 s pour la recette.
- `installer/termux-lite/test-model-efficiency.py` : la fusion, l'idempotence et le périmètre `main` seul.

## Mise en service (Claude)

`model-efficiency-config.py --apply` dans la fenêtre de déploiement, puis redémarrage propre de la Gateway. Ensuite :
- vérifier dans le journal que le premier run après redémarrage n'a plus de `loading whatsapp` ;
- vérifier que `core-plugin-tools` est sous 1 s ;
- vérifier que le canal WhatsApp reste connecté et livre.

## Retour arrière

- Sans déploiement : retirer `whatsapp_call` et `whatsapp_login` de `agents.entries.main.tools.deny` dans
  `~/.openclaw/openclaw.json` (les autres entrées restent), puis redémarrer proprement la Gateway.
- Complet : revert du commit, puis le même retrait, car le script reverti ne retire pas les entrées.
