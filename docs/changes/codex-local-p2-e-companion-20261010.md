# P2-e — routes de diagnostic en lecture

GET logs et export ZIP inline partageable, enveloppe success/state/receipt avec receipt:null. Aucun export dans le registre des runs ; aucune mutation. Contrat : docs/work/samantha-runtime/contracts/p2-e.md.

Validation : tous les contrôles de la CI runtime passent, puis HTTP apparié au module playbooks réel. La partie playbooks doit être fusionnée et épinglée avant activation ; le chemin Contrôle de #18 doit être activé. Claude relit, fusionne et recette.
