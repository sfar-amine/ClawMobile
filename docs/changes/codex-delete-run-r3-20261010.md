# R3 — suppression idempotente d’un message

DELETE avec operationId et reçu dans le registre existant ; accès loopback, runs actifs/protégés refusés, sans changement paiement. Revue corrigée : FIFO/30 jours (1000 reçus), entrées de reçu malformées isolées et signalées sans données brutes, détection payment par capability et capability_id.

Idempotence/anti-résurrection dans la fenêtre effectivement retenue. Aucun nouveau store, scheduler ou exécuteur. Contrat docs/work/samantha-runtime/contracts/r3.md, sans création du doc27. Tests manuels complets ; CI retirée de cette branche tant que R1 n’est pas fusionné. Après fusion R1 par Claude : rebase sur runtime/samantha-companion-private puis ajout du test R3 à la CI.

Git uniquement : recette et activation par Claude. Rollback : revert scoped, conserver le champ runDeletions pour reprise. Aucun événement S24 optionnel émis hors recette.
