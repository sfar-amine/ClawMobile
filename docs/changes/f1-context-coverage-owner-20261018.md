# F1 — propriétaire du contrat de couverture mémoire

Le producteur `context_memory.py` nomme le contrat qu'il émettait déjà : `COVERAGE_COMPLETE` pour la couverture des index, et `COVERAGE_COMPLETE_LEGACY` pour la transition du lecteur depuis les anciennes vues. Le texte produit, son budget et les conditions de `BLOCKED` restent identiques.

Le contrôle F1 existant `runtime_mode.contract_drift`, appelé par `runtime-sync.sh --check`, compare par AST les deux constantes du producteur et la copie du lecteur playbooks. Il ne charge ni n'exécute le code du lecteur. Une constante absente, dupliquée, mal formée ou différente est une dérive explicite. La CI récupère le vrai lecteur de playbooks main au SHA exact déjà journalisé par F1, en plus du propriétaire du budget web ; elle ne pointe pas vers une branche PR pour contourner cette barrière.

Provenance : Claude a confirmé le 18/10 la projection S24 révision 3147, version 1, et sa ligne de couverture, sur core `6592da8e` (commentaire 6249001878 de la PR playbooks #189). Seules la ligne et des métadonnées publiques sont conservées dans la fixture nettoyée. Aucun contenu privé, aucune contrainte, aucun SOUL ou contexte brut n'est copié.

Validation ciblée : 15/15 tests foundations, 16/16 runtime-sync et 20/20 contexte/volumes verts. La parité locale est verte avec le vrai lecteur playbooks main `35108646`, fusionné et activé par Claude via #197. Cela ne constitue pas la preuve de CI complète sur le head GitHub.

Le correctif lecteur #197 a été fusionné et activé par Claude (`35108646`) : le marqueur courant est déjà reconnu et Claw est débloqué. Cette contrepartie reprend les noms publics choisis par #197, `COVERAGE_COMPLETE` et `COVERAGE_COMPLETE_LEGACY`, et vérifie le vrai lecteur main, sans attendre ni imposer un doublon #198. La PR reste empilée sur #320 pour réutiliser son propriétaire de parité. La CI canonique complète doit être rejouée sur ce nouveau head exact. La lecture du contenu intégral des contraintes reste obligatoire : la correction de la phrase « unabridged » et le durcissement des versions de projection restent des reliquats séparés du lecteur.

Aucun nouveau store, registre, route, service ou contrôle d'autorisation. Un index complet ne signifie jamais lecture des corps de contraintes ; le lecteur impose la récupération EVT/REQ avant application. Aucun appel ou effet S24 ni assainissement de l'environnement hérité (décision D). Retour arrière : revert de cette contrepartie, sans modifier les événements ni les projections existantes ; conserver le lecteur compatible #198.
