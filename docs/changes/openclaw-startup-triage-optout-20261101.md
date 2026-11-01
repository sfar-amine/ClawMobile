# Gateway OpenClaw : opt-out explicite du triage automatique au démarrage

## Pourquoi

Quand un démarrage de la Gateway échoue, OpenClaw 2026.9.6 (installé) et 2026.10.9 (candidat) lancent d'eux-mêmes un
triage :

- un processus `openclaw triage` part dans le dos de l'opérateur ;
- il prend un claim dans `managed-update-handoffs.sqlite` ;
- puis il lance soit un tour de réparation embarqué par le modèle configuré, soit `claude -p` ou `codex`.

La répétition 10.9 du 01/11 l'a montré (« Starting claude… Not logged in »). Il n'existe ni clé de config ni variable
dédiée pour le couper. Les gardes amont (`OPENCLAW_SHELL`, `CODEX_THREAD_ID`, `OPENCLAW_SUPERVISOR_MODE`) ont toutes un
autre sens, et la décision est de ne pas les détourner (PR #504).

## Ce qui change

**Nouveau jeu épinglé `startup-triage-optout`**, appliqué par le propriétaire existant (`whatsapp-network-recovery.py`,
nouveau choix `--patch-set`).

| Version | Module | Empreinte d'origine | Empreinte corrigée |
|---|---|---|---|
| 2026.9.6 | `dist/triage-failure-BI1ymYSt.mjs` | `79f50449…` | `ccffc43c…` |
| 2026.10.9 | `dist/triage-failure-DoR3aje_.mjs` | `a19382f0…` | `5a105ff1…` |

Le correctif ajoute une seule garde en tête de `triageAfterFailure` :
`failure.kind === "gateway-startup" && process.env.OPENCLAW_STARTUP_TRIAGE === "off"`.

Quand elle s'applique, la fonction écrit une ligne de journal et retourne. Rien d'autre ne part :

- ni pont de signal, ni recherche du paquet ;
- ni processus frais, ni claim, ni agent, ni modèle.

Le reste ne bouge pas :

- le triage d'un échec de mise à jour (`kind: "update"`) ;
- toute autre valeur de la variable ;
- l'absence de variable.

**Les deux chemins passent par cette fonction.** L'échec final du démarrage et l'échec d'une relance en processus
(`onRestartStartupFailure`) appellent la même closure `triageStartupFailure`, puis `triageGatewayStartupFailure`. Le
module `triage-failure-*` y est une simple réexportation de la fonction corrigée. C'est vérifié sur les modules `run-*`
des deux versions. En 10.9, une relance qui échoue avec l'opt-out donne « Automatic triage did not complete a repair;
awaiting manual recovery », puis l'attente de récupération manuelle, comme avant ; il n'y a pas de nouvelle tentative.

**Activation dans `gateway-start.sh`.** Le jeu suit la même règle de propriété que les autres. La variable
`OPENCLAW_STARTUP_TRIAGE=off` est exportée seulement si le jeu a été appliqué (`--apply`) et que `--check` le confirme,
juste avant `exec openclaw gateway`. Tous les démarrages passent par ce script : le watchdog des services et le
Companion (`CLAWMOBILE_RUNTIME_START_COMMAND`, vérifié sur le S24). Une checkout sans le manifeste remet le module
d'origine (`--rollback`) et n'exporte rien. Un refus n'empêche jamais le démarrage.

**`runtime-sync.sh` et `companion-deploy.sh`.**

- `runtime-sync.sh` contrôle la dérive (`openclaw:startup_triage_optout`) et applique le jeu.
- Une application redémarre la Gateway par le chemin existant, pour que la variable prenne effet.
- Le retour arrière du déploiement défait le jeu si la révision précédente ne possède pas ce manifeste à l'octet près.

## Provenance (S24, lecture seule, 01/11)

- **Production 2026.9.6** :
  - `triage-failure-BI1ymYSt.mjs` (`79f50449…`) et `triage-failure-B_xmAewo.mjs` (`b53f9ca5…`) sont identiques au paquet
    npm ;
  - `run-S_R0Bn7l.mjs` ne diffère que par la réécriture Termux de `/bin/sh` ; ses lignes de triage sont identiques.
- **Candidat isolé 2026.10.9** (`~/.openclaw-android/staging/oc-global`) :
  - `triage-failure-DoR3aje_.mjs`, `run-HO6sETAH.mjs` et les trois modules de `gateway-prep-stages` (#504) sont
    identiques au paquet npm (archive `43c61a00…`).

## Tests

`installer/termux-lite/test-startup-triage-optout.py` (10 tests, inscrit dans `ci.yml`) couvre :

- les empreintes d'origine égales aux modules S24 ;
- l'application, le check, la réapplication et le rollback exact pour les deux versions ;
- le refus avant toute écriture sur une empreinte ou une version inconnue ;
- la VM sur le corps public original et corrigé : garde active sans aucun effet, comportement d'origine sinon ;
- `node --check` ;
- les deux chemins de démarrage vers la fonction gardée ;
- la récupération de relance 10.9 qui attend l'opérateur ;
- l'export seulement après une application vérifiée, et aucun export après un refus ou un rollback ;
- le câblage sync et deploy ;
- le contrôle d'imports de `test-openclaw-compat-imports.py` ;
- un jeu disjoint des autres.

## Limites et retour arrière

La première synchronisation sur la 2026.9.6 appliquera le jeu et redémarrera la Gateway une fois. Le triage d'un
`openclaw update` lancé à la main n'est pas concerné.

Retour arrière : revenir sur ce commit. La synchronisation et le retour arrière du déploiement défont le jeu ; à la
main, lancer `whatsapp-network-recovery.py --patch-set startup-triage-optout --rollback`, puis redémarrer par le
propriétaire Gateway.

**NO_CAPABILITY** : aucune route, action ou capability. Le paiement n'est pas touché.
