# OpenClaw 2026.9.6 — modules publics importés par les correctifs de compatibilité

Fichiers `*.gz` (gzip -9, sans nom ni horodatage) : modules publics du paquet npm `openclaw@2026.9.6`, à l'octet près.
Ils ne sont pas modifiés : ce sont les cibles des `import … from "./X.mjs"` qu'ajoutent les jeux épinglés sur 2026.9.6
(`installer/termux-lite/openclaw-compat/*.json`, clé `files`), vérifiées par `installer/termux-lite/test-openclaw-compat-imports.py`.

- `store-CGYBYVbs.mjs.gz` (sha256 `8bb2d4ba9a1a5050280c9cd4dfb3a83f54954be3bbee0edb84a673f17fa2d2b3`) : `c` = `getScopedAuthProfileEnv`,
  importé par `agent-exec-auth-scope`.
- `hook-runner-global-C81Znoo2.mjs.gz` (sha256 `719ec3d1b37d512b51367dc08dbafaade7e72ed533910ab5e491b26287df2cb6`) : `t` = `getGlobalHookRunner`,
  importé par `model-flow-selection`.

Provenance : `npm pack openclaw@2026.9.6` dans le conteneur Claude Code le 01/11/2026 (archive sha256
`1a7355691bc0e605222ba818f1f72c1787253c78dfeb0df6be2086ec73b71e63`), extraction ciblée, archive supprimée. Les modules
de la même archive déjà capturés depuis le S24 sont identiques à l'octet (`runtime-BnnQBrxr.mjs`
`2f3fd805…844a`, `setup-B7DuERIi.mjs` `1caa8afe…efbf`, `run-entry-Bg2j-prG.mjs` `876ee6b7…b8ce`) : le paquet npm est bien
celui installé en production. Les autres cibles 2026.9.6 sont lues dans `s24-2026-10-25-model-flow-sdk/`.

Aucun transcript, aucune configuration, aucun identifiant : seulement du code public, sous licence OpenClaw.

Jeu `startup-triage-optout` (01/11/2026, même archive npm) — modules corrigés ou lus par le test, et non plus seulement
importés :
- `triage-failure-BI1ymYSt.mjs.gz` (sha256 `79f50449…9afac1`, identique en production sur le S24, relevé en lecture
  seule le 01/11) : `triageAfterFailure`, que vise le jeu ;
- `triage-failure-B_xmAewo.mjs.gz` (`b53f9ca5…`, identique en production) : sa réexportation ;
- `run-S_R0Bn7l.mjs.gz` (`aa7e2bb3…`) : le module npm. En production, ce fichier ne diffère que par la réécriture
  Termux de `/bin/sh` (`885f8d58…`) ; ses lignes de triage sont identiques, aux mêmes numéros (1973-1982, 2527-2532,
  2574, 2628).
