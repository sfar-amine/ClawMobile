# Appels directs des outils typés admis (30/10/2026)

Avec #476, les outils typés fréquents (factures, agenda, Pulse…) sont visibles directement par le cerveau. Il les appelle
alors avec l'identifiant de l'appel fourni par le modèle, de la forme `call_…|fc_…`. Le garde-fou n'acceptait pas le `|`
et refusait chaque appel (`capability_first_required`) : Samantha répondait « l'accès Agenda est momentanément
indisponible ». Le déploiement de `dbe0f455` a été annulé par les parcours de recette, sans aucune écriture.

Le garde-fou accepte maintenant ce caractère ; l'identifiant reste une clé à usage unique. Les parcours de déploiement
considèrent aussi « est momentanément indisponible » comme une réponse cassée (la lecture d'agenda était passée à tort).
