# Recette : un TECHNICAL_FAILURE d'outil typé fait échouer le parcours — 2026-11-02

## Constat
Du 01/11 au 02/11, la lecture d'agenda répondait `TECHNICAL_FAILURE` (« Cette action est reconnue, mais elle n'est pas disponible pour le moment. », sans facts) : la route `agenda.google.connector` était restée ouverte après la clôture de l'incident Google 8a24d3fd. `owner_read` passait quand même sur la phrase.

## Changement
`deploy-parcours.py` : un résultat `samantha_*` du tour en `TECHNICAL_FAILURE` sans autorisation fournisseur nommée → parcours en échec `typed_technical_failure`. Une autorisation Google nommée garde son verdict « inconclusive ».

## Retour arrière
Revert du merge.
