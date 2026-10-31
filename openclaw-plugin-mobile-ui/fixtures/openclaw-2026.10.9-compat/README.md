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
