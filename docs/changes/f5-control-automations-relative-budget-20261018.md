# F5 — budget relatif des lectures automations

Le test conserve la capture SQLite S24 et les latences relevées sur le S24 : collecte de 2 475 ms, probe de révision de 128 ms. Avant les assertions HTTP, trois mesures de référence exécutent le même probe Python/SQLite et le timer de réponse différée de 80 ms sur la machine de CI. Le maximum constitue la référence locale. Le budget HTTP est cette référence multipliée par 300 / (probe S24 + 80), afin de conserver la cible initiale de 300 ms sur la machine de référence S24 sans confondre les pauses d'un conteneur avec du travail supplémentaire.

Le budget calibré doit rester inférieur à la moitié de la collecte mesurée : une calibration trop lente échoue au lieu de laisser passer une lecture bloquée sur le collecteur. Les contrôles de réponse différée, cache, compteur de collectes, huit lectures concurrentes, révision, expiration de fraîcheur et invalidation après mutation restent actifs. La sortie JSON contient référence, échantillons, budget et mesures HTTP. Les variables d'environnement sont restaurées et le dossier temporaire est supprimé dans finally. Aucun code de production, route ou capability ne change.

Validation ciblée : compilation TypeScript et test-control-automations-latency.cjs verts. Dernier rejeu : collecte 2 505,95 ms, référence 237,49 ms, budget relatif 341,91 ms, lecture froide 251,85 ms, cache 160,17 ms. Le test est déjà inscrit dans ci.yml. La preuve de CI complète sur le head exact sera ajoutée à la PR. Aucune recette S24 ni activation n'est prétendue.

Retour arrière : revert de la modification de test.
