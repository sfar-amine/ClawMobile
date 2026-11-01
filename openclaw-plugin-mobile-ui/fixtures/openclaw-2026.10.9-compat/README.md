# OpenClaw 2026.10.9 — modules publics des correctifs de compatibilité

Fichiers `*.gz` (gzip -9, sans horodatage) : modules publics du paquet npm `openclaw@2026.10.9`, à l'octet près, que
visent les variantes `2026.10.9` des jeux `memory-retrieval-warm`, `native-turn-provenance`, `agent-exec-auth-scope`
et `model-flow-selection` (`installer/termux-lite/openclaw-compat/*.json`, clé `packages`).

Provenance : `npm pack openclaw@2026.10.9` dans le conteneur Claude Code le 31/10/2026. Le même paquet a été installé
sur le S24 en candidat isolé (`~/.openclaw-android/staging/oc-global`, `npm install -g --prefix … --ignore-scripts`,
production non touchée). Le jeu `model-flow-selection` y a été reconstruit avec les mêmes ancres et donne le même
résultat (empreinte de la liste de fichiers `514eed9e…` des deux côtés). Les cinq modules corrigés s'y importent
avec leurs dépendances réelles (`hooks`, `context-engine-maintenance`, `compact`, `embedded-agent`, `run-entry`).

Aucun transcript, aucune configuration, aucun identifiant : seulement du code public, sous licence OpenClaw.

WhatsApp : `connection-controller-CejM7bhn.mjs.gz` et `monitor-DVzumwCI.mjs.gz` sont les modules publics du paquet npm
`@openclaw/whatsapp@2026.10.9` (`npm pack`, même jour), plugin que OpenClaw installe à sa propre version ;
`server-runtime-startup-services-CSJSnUKS.mjs.gz` vient de `openclaw@2026.10.9`. Ils portent la variante 2026.10.9 du jeu
`whatsapp-network-recovery` : même correctif, ancres suivies là où l'amont a déplacé `heartbeatSeconds`,
`reconnectPolicy` et `keepAlive` sous `this.params` et fusionné la décision de reprise.

Jeu `gateway-prep-stages` (préparation du 01/11/2026, `npm pack openclaw@2026.10.9` dans le conteneur Claude Code,
archive sha256 `43c61a00ef2c73416a072a7216cb3be80555d6740199f07194da2714283b04ab`, extraction ciblée de `dist/`) :
`openclaw-tools-CSSYZDKR.mjs.gz`, `tools-DQdRObqo.mjs.gz` et `attempt-system-prompt-prepare-ChKsbjSh.mjs.gz` sont les
modules publics, à l'octet près, que vise la variante `2026.10.9` de ce jeu. En 2026.10.9 la préparation du system
prompt a quitté `builtin-openclaw` pour `attempt-system-prompt-prepare` et `setup.prepStages` y devient optionnel (le
tour worker n'en passe pas). Le tracker `dist/stage-timing-BUG4Fnsv.mjs` de 2026.10.9 a les mêmes octets (sha256
`1d8cfb8d…`) que la capture S24 2026.9.6 de `../s24-2026-10-26-gateway-prep-stages/`, réutilisée telle quelle.
`gateway-prep-stages-harness.cjs` n'est **pas** une capture : c'est le harness écrit pour
`installer/termux-lite/test-gateway-prep-stages-1009.py` ; il exécute dans une VM les corps publics originaux puis
patchés avec des dépendances inertes (aucun import du SDK, aucun réseau, aucun modèle). Les empreintes de ces trois
modules sur le candidat isolé du S24 restent à confirmer avant toute application.
