# H4 — challenge de confirmation R6

Une extension de secours sans confirmation donne 403 `confirmation_required` avec `scope`, `reference` et `payloadHash` explicites. Le challenge et la consommation réutilisent exactement le hash canonique R6. Les erreurs restantes, la protection paiement et les exigences de confirmation sont conservées.

Tests sur captures réelles config/catalogue/auth, latences injectées et budget importé de READS. Aucun effet Gateway réussi fabriqué, aucune modification Android. [Contrat H4](../work/samantha-runtime/contracts/h4.md).

Le test de recette UI vérifie aussi le challenge 403 complet et son hash, sans écriture Gateway avant biométrie. Toutes les étapes de tests du workflow CI sont rejouées localement, y compris les régressions paiement existantes.

Reprise42 : base `8ae69384` ; build, défi exact H4, R6 et recette serveur verts. Log `h4-core-lot3-targeted.log`. Publication conditionnée par la CI entière verte au SHA exact. Android #158 et recette physique distincts.
