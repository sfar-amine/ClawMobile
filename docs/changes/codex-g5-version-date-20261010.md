# G5 — date de déploiement de la version Companion

La lecture updates affiche la date ISO du reçu Companion G4 correspondant au
commit courant. Une preuve absente ou invalide donne null ; version npm et commit
court existants sont conservés. Aucun lecteur, store ou cache parallèle.

Build et tests G5, updates et G4 verts. Vrai HTTP /updates : dix lectures froides
concurrentes en 620 ms, délai capturé de 550 ms ajouté au vrai helper, budget 4 s,
un helper et un lecteur G4. Les huit captures réelles et leurs fichiers restent
intacts ; la variation de target pour HEAD local est explicitement un test,
pas un déploiement S24. [Contrat](../work/samantha-runtime/contracts/g5.md).

Éligible à la relecture, empilé sur G4 ; aucun merge ni déploiement Codex.
