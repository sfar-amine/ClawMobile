# HS6 — Protection partagée des codes humains

La présentation HS3 fusionnée est le propriétaire unique des champs publics. Le lecteur `readReceiptPresentation` refuse les textes portant un OTP, PIN ou code de vérification explicitement désigné avec une valeur courte, y compris chiffres Unicode. Une phrase de compréhension facultative contenant un code est omise. Le lecteur conserve les nombres usuels et instructions sans valeur. Aucun mot de paiement ne déclenche cette protection.

La PR #137 se limite à cette protection partagée et ses tests. Les plans V1, gestes V2 et rendus V3 du relais ont été retirés pour ne conserver qu'une implémentation : `voiceUnderstanding.ts` dans #150 consomme le lecteur HS3. #150 intègre cette branche par merge, avec runtime comme base explicite. Claude fusionne #137 avant #150. Aucun parcours de paiement, route, registre, état persistant ou appel fournisseur modifié.

Fixtures contractuelles authored, distinctes des captures S24 existantes. Test `test-voice-receipt-metadata.cjs` inscrit dans toute la CI. Il couvre chaque champ public, confidentialité, immutabilité, nombres ordinaires et 1000 projections sous une seconde avec 50000 champs étrangers. Ce budget pur ne constitue pas une mesure audio S24.

La recette voix FR/EN/derja, les phases de parole et les reçus audio sont portés par #150 et qualifiés par Claude avec Amine sur S24. Retour arrière : revert du durcissement partagé ; aucune donnée ni migration.
