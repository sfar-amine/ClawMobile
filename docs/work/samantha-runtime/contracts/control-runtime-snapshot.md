# Contrôle — snapshot runtime canonique

Sans override explicite, controlPaths().playbooks sélectionne ~/.openclaw/runtime-ui-playbooks/current lorsqu’il existe, comme claw-capability et model-fast-path. Le workspace mutable n’est consulté que sur une installation ancienne sans snapshot épinglé. SAMANTHA_CONTROL_PLAYBOOKS reste une sélection explicite pour les tests et le développement.

Les lectures Contrôle et les façades qui réutilisent controlPaths lisent le même snapshot ; le flux claw-live conserve sa source propre et sa vue owner de PR #12. Aucun changement d’activation, de paiement ou de S24. Le test exécute deux sources Python différentes pour prouver quelle version est réellement lue, puis vérifie override et compatibilité legacy.

Ordre de résolution : SAMANTHA_CONTROL_PLAYBOOKS, CLAW_UI_PLAYBOOKS_ROOT, current uniquement avec reporting/control_snapshot.py, puis workspace. Les deux overrides explicites restent des choix explicites même sans marqueur ; la sélection implicite de current exige le marqueur.
