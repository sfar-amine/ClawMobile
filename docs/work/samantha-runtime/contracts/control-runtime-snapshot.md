# Contrôle — snapshot runtime canonique

Sans override explicite, controlPaths().playbooks sélectionne ~/.openclaw/runtime-ui-playbooks/current lorsqu’il existe, comme claw-capability et model-fast-path. Le workspace mutable n’est consulté que sur une installation ancienne sans snapshot épinglé. SAMANTHA_CONTROL_PLAYBOOKS reste une sélection explicite pour les tests et le développement.

Les lectures Contrôle et les façades qui réutilisent controlPaths lisent le même snapshot ; le flux claw-live conserve sa source propre et sa vue owner de PR #12. Aucun changement d’activation, de paiement ou de S24. Le test exécute deux sources Python différentes pour prouver quelle version est réellement lue, puis vérifie override et compatibilité legacy.
