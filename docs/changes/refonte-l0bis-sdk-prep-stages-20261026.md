# L0bis — découper le span plugins avant les factories

Une question publique dans l'app S24 a produit un run SDK corrélé sans outil :
le span de préparation plugin coûte11154ms, alors que les53factories coûtent16ms.
Les logs existants ne permettent pas de choisir entre préparation du contexte,
auth lookup, résolution des owners ou chargement du registre. Cacher les outils
de chaque tour ou remplacer le préchauffage n'est donc pas justifié.

Le patch ajoute11checkpoints fermés au callback `recordToolPrepStage` existant,
et huit sous-spans system-prompt via measure/measureSync, dans trois modules
publics2026.9.6 dont les hashes sont identiques au S24. L'aggregate system-prompt
original reste comparable : ces spans explicites n'avancent pas son checkpoint.
Il
réutilise le propriétaire de compatibilité verrouillé, atomique et réversible
avec un ensemble séparé `gateway-prep-stages`. Aucun hook de démarrage ne l'active
automatiquement ; root peut appliquer seulement cette instrumentation après CI,
sans activer L3, foundation ou BRAIN_ONLY. Aucun logger, profiler, cache, route ou
permission ajouté. Le callback absent conserve le comportement original.

La fixture contient les programmes publics complets et des mesures nettoyées,
sans transcript/config/auth/journal brut. Le nouveau test inscrit en CI couvre
version/hash/symlink, refus avant toute écriture, idempotence et rollback, puis
les mêmes fonctions originales/patched avec des propriétaires inertes : retours,
effets, erreurs, callback optionnel, branches registre réutilisé/chargé et
conservation de l'aggregate parent avec le tracker SDK exact. La
vérification ciblée et la CI canonique combinée restent à exécuter.

**NO_CAPABILITY** : ensemble ponctuel du propriétaire privé existant, aucune
route ou action app/voix/MCP ajoutée ; parité MCP sans impact. Le paiement reste
intact. Retour arrière par le même owner `--patch-set gateway-prep-stages
--rollback`, redémarrage par le propriétaire Gateway existant, puis vérification
des hashes initiaux et du nouveau PID ready. Ce changement comble un manque de
diagnostic ; aucun gain ni clôture L0bis n'est anticipé.

La procédure et les limites sont dans
[le runbook L0bis](../work/samantha-refonte/L0bis-sdk-prep-stage-splits-20261026.md).
