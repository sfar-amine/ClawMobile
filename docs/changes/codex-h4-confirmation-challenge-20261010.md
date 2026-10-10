# H4 — challenge de confirmation R6

Une extension de secours sans confirmation donne 403 `confirmation_required` avec `scope`, `reference` et `payloadHash` explicites. Le challenge et la consommation réutilisent exactement le hash canonique R6. Les erreurs restantes, la protection paiement et les exigences de confirmation sont conservées.

Tests sur captures réelles config/catalogue/auth, latences injectées et budget importé de READS. Aucun effet Gateway réussi fabriqué, aucune modification Android. [Contrat H4](../work/samantha-runtime/contracts/h4.md).
