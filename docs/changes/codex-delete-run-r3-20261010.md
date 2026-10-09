# R3 — suppression idempotente d’un message

Ajout de DELETE /v1/runs/{id} avec operationId et reçu persisté dans le registre Companion existant. La suppression vise un élément terminal d'historique ; aucun annulateur externe ni parcours paiement n'est ajouté. Les callbacks tardifs et les resoumissions de l'identité supprimée ne recréent pas le message.

Contrat C14 dans le doc 27. Tests HTTP/propriétaire, idempotence, conflit, concurrence, restart, gardes et anti-résurrection ; build, admission, courses backfill, trace-induction et payment-core.

Architecture : même propriétaire et même fichier runs.json, avec reçus de suppression bornés. Aucun second store/registry/scheduler. Les six primitives MCP conservent leurs contrats ; le nouvel endpoint est exclusivement natif loopback. Android et M1 inchangés.

Git uniquement : recette, reçu S24 et activation par Claude. Retour arrière : revert R3 ; l'ancien lecteur ignore le champ de reçus additionnel, sans migration. Les reçus doivent être conservés pour une reprise ultérieure anti-rejeu.
