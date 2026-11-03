# S24 01/11/2026 : verrou de configuration d'OpenClaw 2026.10.9 non reconnu par gateway-preflight

Relevé en lecture seule sur le S24 de prod, entre 22:36 et 22:40 UTC. Le home est noté `~` et l'identifiant du propriétaire est masqué.

En 2026.10.9, le verrou de configuration de la Gateway s'appelle `state.<hash>.lock`, et non plus `gateway.<hash>.lock`. Il n'a pas non plus de fichier `.sqlite` associé.

`gateway-preflight.py` ne cherchait que `gateway.*.lock`. Il a donc compté 0 candidat et refusé la récupération (`config_lock_ambiguous`), alors que le propriétaire du verrou était mort et le port fermé.

Le test qui rejoue ce cas : `installer/termux-lite/test-gateway-preflight.py`.
