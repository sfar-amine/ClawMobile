# ADR — Réouverture conditionnelle de la maintenance

Date : 22 octobre 2026. Portée : propriétaire existant `companion-deploy.sh`, aucune activation exécutée par ce lot.

Le laboratoire doit restaurer son pin et rouvrir uniquement **sa** fermeture de maintenance. Une vérification de statut suivie d’un `open` ne protège pas une fermeture urgente concurrente. Un contrôle d’epoch seul est insuffisant : la fermeture legacy d’un état déjà fermé conserve son epoch.

Le même propriétaire ajoute `--maintenance capabilities` (contrat version 1) et l’opération `open --expected-epoch N --expected-revision HEX32`. La comparaison et l’écriture se font sous le **même verrou existant** `maintenance.lock`. Une révision d’état est renouvelée à chaque close, même quand l’epoch reste inchangée. Ce champ n’est ni une permission ni un jeton d’autorisation ; il identifie l’état du marker existant. Aucun store supplémentaire.

La paire conditionnelle est indivisible : argument manquant, inconnu, répété ou mal formé refuse avant écriture. Une epoch ou révision différente refuse avec code 4 et conserve le marker. Un open conditionnel répété sur le même état déjà ouvert est une lecture idempotente. L’API legacy close/open, les epochs et le propriétaire unique restent compatibles.

L’ouverture des fichiers de verrou et marker refuse les symlinks et fichiers non réguliers, sans lecture bloquante d’un FIFO. Le verrou Python `fcntl` réutilise exactement le fichier existant et son attente bornée, sans dépendre d’une option de `flock` disponible ou absente dans le PATH Termux. Aucune modification de l’environnement global hérité du Bridge.

Le client du laboratoire doit vérifier la capacité **et** le source propriétaire core committé/observé avant sa première fermeture ou activation. Un ancien script ignore certains arguments inconnus : il ne doit jamais recevoir un faux CAS supposé. L’absence du propriétaire qualifié reste fermée, sans fallback check-then-open.

Tests : vrai script propriétaire sur HOME temporaire, fermeture concurrente epoch 99, second close canonique à epoch inchangée, absence de révision, arguments invalides, idempotence, verrou détenu et chemins hostiles. Aucun déploiement, appel de modèle, paiement ou téléphone.
