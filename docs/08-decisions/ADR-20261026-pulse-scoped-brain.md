# ADR — cerveau propriétaire et service professionnel contact

**Remplacé en partie le 02/11/2026** par samantha-ui-playbooks `docs/08-decisions/ADR-20261102-brain-everywhere.md` (décision d'Amine, le cerveau partout) : les contacts de la pièce Pulse suivent le même chemin du cerveau qu'Amine, un seul chemin, sans interrupteur ni repli natif conservé ; le service professionnel séparé n'est plus la cible. Le reste de cet ADR s'applique.

La portée canonique du parcours unique est Amine : toute demande d’Amine, y compris son WhatsApp et sa voix, va au cerveau principal avec les outils déterministes. Les contacts Pulse gardent leur service professionnel existant, une seule IA déjà admise Gemini sous pulse_interpretation, DATA01/C2 et WholeProjectionAttestation ; aucun interprète ne précède un second cerveau SDK dans cette pièce. Le flag propriétaire ne crée aucun droit, purpose, compte ou consentement supplémentaire pour ces données.

Le garde hôte before_dispatch écarte l’acteurSDK propriétaire/main avant le service professionnel contact. Les identités, permissions, workspace/instructions et confirmations restent aux propriétaires actuels. La confidentialité ne se déduit ni du coût gratuit ni d’une identité déclarée dans le texte. Les outils typés propriétaires restent isolés des contacts.

La réparation multi-demande conserve le message global, les références des enfants et la file CAS du dialogue. Le formatter du coordinateur produit la même vue global+demande active au port et au propriétaire NativeRoomContextReadEvidence, scellée dans la WholeProjection existante. Un contexte absent/forgé ou une référence enfant incompatible refuse avant inférence ; une réponse humaine conserve son message brut, avec le contexte déjà admis du but courant. Le retrait d’un enfant est lié à son événement exact et à un résultat terminal certain, jamais à sa simple émission.

Aucun nouveau routeur, store, hook sémantique, démon, retry ou planificateur. La qualification finale exige les contrôles appariés Core/PB et la CI canonique exacte, puis activation/recette native séparée. Les mocks de source ne sont pas une preuve fournisseur ou S24.
