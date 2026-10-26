# Attester la fin du collecteur avant le cache

Le contrôle de latence des automatismes attendait la durée capturée du collecteur, puis exigeait immédiatement `deliveryMode=cache`. Le propriétaire vérifie aussi la révision SQLite après la collecte. Une lecture qui partage cette dernière promesse peut donc rejoindre le vol encore actif et recevoir légitimement `coalesced`, avec des données fraîches.

Une régression à promesses contrôlées utilise le vrai `ControlReadPool` : une seule génération, lecture pendant la révision finale `coalesced`, puis lecture après la fin observée `cache`. La recette HTTP existante attend ensuite une réponse fraîche du vol avant d'exiger le cache sur la lecture suivante. Aucun délai ni seuil n'est augmenté ; aucune boucle de retry n'est ajoutée.

Le code runtime, le TTL, les mécanismes de partage, les budgets et les captures S24 existantes restent inchangés. La nouvelle synchronisation est une fixture authored ; elle ne constitue pas une nouvelle preuve native S24. Aucun changement de capability ou de parité MCP : `NO_CAPABILITY`, tests uniquement.

## Vérification

- Échec original conservé : merge D8, étape77, `cache` attendu / `coalesced` observé. La cause a été reproduite avec deux promesses contrôlées, sans timer ni modèle.
- Suite existante `scripts/test-control-automations-latency.cjs` passée sous Node26.11.1 avec la nouvelle régression et les captures S24 inchangées. Collecteur2555ms, lecture froide305ms et cache212ms, sous le budget relatif existant445ms sur cet hôte.
- Le fichier est déjà exécuté par `.github/workflows/ci.yml`, étape «Test automation SQLite revision latency and cache» ; la nouvelle régression est dans cette même entrée.
- CI canonique du head exact à exécuter avant fusion. Aucune activation ou recette S24 revendiquée.

Retour arrière : revert de cette PR de tests et documentation. Aucun changement runtime à annuler.
