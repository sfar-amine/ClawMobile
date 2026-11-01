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
