# V1/V2/V3 : présentation HS3 et clarification conservées

#150 consomme les lecteurs HS3 désormais fusionnés et la protection partagée #137 ; supprimer les recalculs depuis sélection/plan/devis. Conserver la clarification E3/O10, l'originId et une admission warm unique. La décision et présentation publiques traversent le propriétaire existant sans résultat privé. Le relais transmet aussi les échecs de clarification avec state=failed et sans repli agent. Aucune preuve de soumission ne peut produire une assurance contradictoire de non-débit.

Tests contractuels nouveaux dans la suite voix déjà inscrite en CI, captures HS3 réutilisées, aucune capture audio inventée. Qualification S24 et derja/arabizi par Claude avec Amine. Aucun module de paiement modifié, aucune nouvelle route/store. Retour arrière par revert, aucune migration. Contrat : docs/work/samantha-runtime/contracts/voice-understanding.md.

Revue sur capture réelle #176 : les traces de financial_dispatch_committed priment aussi quand financialSubmissionAttempted manque. Le JSON et README de f036943cc63af9401e7d5e242ba3b379d61056ea sont copiés byte-identiques ; aucune décision.type masquée n'est reconstruite. Cette preuve concerne l'assurance de non-débit, pas la qualification audio ou le statut stocké du run.


Vérifications ciblées locales au 11 octobre, Node 20 : compilation TypeScript, 20/20 cas voix, 44 contrôles E3 et admission O10 réussis sous verrou exclusif. Readiness conditionnée à la suite CI entière verte au SHA final, preuve dans la PR. La base runtime #180 est intégrée par merge normal ; ses modules paiement restent hérités et sans delta propre à ce lot.

La présentation payment seule de #180 perd la trace antérieure de dispatch #176 ; son notDone ne prouve pas un non-débit. La voix omet donc cette assurance sans preuve publique propriétaire cohérente, tout en conservant la lecture historique HS3 et le refus des contradictions. Signalement à Claude : https://github.com/sfar-amine/samantha-core/pull/180#issuecomment-6109132754. La confiance est lue du propriétaire canonique ; sa qualification sur la capture #173 appartient au correctif playbooks #90, sans hausse locale inventée.
