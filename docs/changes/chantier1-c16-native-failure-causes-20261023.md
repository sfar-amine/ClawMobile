# C16 — rendre les causes natives manquantes

Le test exhaustif HS3 détectait un code de protocole Pulse sans phrase française. Le propriétaire de présentation couvre les nouvelles causes natives avec leur traduction exacte et conserve les résultats inconnus comme inconnus, sans promettre zéro effet ou proposer un retry.

Le rendu de la pièce native réutilise ces phrases ; les refus de scope et les entrées héritées ne changent pas. Le test exhaustif est renforcé pour les quotes simples et les codes du helper, sans retirer d’assertion. [Contrat et limites](../work/samantha-runtime/contracts/c16-native-failure-causes.md). Aucun protocole, exécuteur, paiement, OAuth, accès ou état modifié. Retour arrière : revert source uniquement, sans rejouer de commande.
