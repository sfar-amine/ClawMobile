# HS6 — Adaptateur voix optionnel, sans branchement runtime

Le [contrat HS6](../work/samantha-runtime/contracts/hs6.md) prépare le transport du sous-contrat HS3 reconnu vers la voix. Lecteur pur, champs fermés, effet inconnu, langue explicitement concordante. Aucun nouveau canal, fournisseur, store, routeur ou chemin de paiement.

Onze tests contractuels générés passent et sont inscrits à la CI ; compilation TypeScript réussie. Ils ne qualifient pas le S24. Aucun endpoint ni relais n'importe l'adaptateur : aucun budget de route ou ligne de recette active n'est prétendu ajouté. Le lot reste bloqué sur les quatre captures réelles, les formes HS4/HS5 et le lien langue du tour. Retour arrière sans migration : retirer le lecteur et son test.

Contrelecture locale : un OTP à quatre chiffres désigné était accepté par le reader HS3 partagé. Exclusion voix sur tous les champs visibles ajoutée, avec régression OTP/PIN courts (y compris chiffres Unicode), textes non secrets préservés et mutation source/projection indépendante. Reader HS3 partagé et paiement inchangés.
