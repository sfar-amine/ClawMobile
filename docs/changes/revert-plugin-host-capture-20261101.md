# Revert de #510 (capture du plugin par l'hôte) : outils typés refusés sous OpenClaw 2026.10.9 (01/11/2026)

## Incident
Le 01/11 à 22:33 UTC, la recette du déploiement `9862fd25` échoue sur `owner_read` et `write_recap` (`broken_reply`). C'est la première fois que le plugin de #510 est réellement chargé par la Gateway 10.9.

Le déploiement précédent, `d55ad8f6`, n'avait jamais redémarré la Gateway. Son `owner_read` avait donc été servi par l'ancien plugin, encore en mémoire.

Extrait du transcript de recette (`agent:main:recette-deploy:20261101t223304z`, résultats d'outils uniquement) :
- `samantha_agenda` `agenda.event.read` → `{"state":"unverified","reason":"typed_host_admission_required"}`
- `samantha_agenda` `agenda.event.create` → même résultat ; aucun rendez-vous ajouté.

## Cause
La preuve d'invocation typée est déposée par le hook `before_tool_call` dans une `Map` du module `capabilityAgentGuard`. L'outil ne l'a pas retrouvée à l'exécution.

Ce symptôme correspond à un hook et à des outils qui s'exécutent dans deux instances du module depuis la nouvelle capture de #510 (`importHostModule`, installation réduite). Le plugin d'avant #510 fonctionnait sous 10.9 en prod (21:06-22:28).

## Correctif
Revert complet du merge `d55ad8f6`, sauf sa note `plugin-host-capture-20261101`, conservée comme historique. #513, #514 et le reste de la base sont conservés.

## Suite
#126 redevient ouvert. Une nouvelle tentative devra prouver, par un test, que le garde et les outils partagent une seule instance de module sous la capture 2026.10.9.

## Retour arrière
Réappliquer #510 uniquement avec ce test.
