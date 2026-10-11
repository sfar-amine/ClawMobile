# HS6 — Transport de présentation vers la voix

## Préparation initiale (historique ; suite active décrite ci-dessous)

`readVoiceReceiptMetadata(ownerReceipt, sessionLocale)` est un adaptateur pur **non branché** dans `clawLive`, `voiceRelay`, les routes HTTP ni le protocole de tour. Il réutilise uniquement `readReceiptPresentation` et `publicReceiptMetadata` de HS3. L'appelant futur doit être le propriétaire du résultat de capability/run ; une forme JSON valide ne prouve jamais sa provenance.

Seul `ownerReceipt.presentation` top-level est lu. Aucun `result` texte/JSON, `capabilityResult`, `spoken` brut, statut de run, événement ou sortie fournisseur ne devient une présentation. La projection rend `presentation`, son `spoken`, `understood`, `alternatives` et `failure` HS3 fermés. Aucun effet négatif ou succès n'est déduit : sous-contrat actuel `info|error`, `effect.debited=unknown` seulement.

Régression locale reproduite : le reader partagé HS3 autorisait « Votre OTP est 1234 » dans les champs visibles car il rejette les valeurs à six chiffres, pas les codes courts désignés. L'adaptateur voix ajoute une exclusion fermée des OTP/PIN/codes de vérification explicitement désignés suivis de chiffres, sur tous les textes qu'il transporte. Aucune valeur n'est masquée puis prononcée ; l'ensemble des métadonnées reste absent. Les textes non secrets (« Étape 2 », « Code HTTP 404 », instructions de confirmation sans valeur) restent inchangés. Le reader HS3 commun reste intact : cette correction ne prétend pas fermer ses autres usages ni qualifier une détection universelle de secret.

La langue doit être explicitement `fr|en` et identique à la locale de la présentation validée. Absence, langue différente ou non prise en charge : métadonnées absentes ; aucune traduction ou détection de langue locale. Cette préparation ne décide pas comment obtenir la langue réellement parlée d'un tour live. HS4 `clarification` et HS5 `progress` ne sont pas recopiés tant que leurs contrats propriétaires et captures ne sont pas qualifiés.

## Tests et budgets

Onze cas contractuels générés explicitement, jamais présentés comme captures S24 : info/error, langue concordante, JSON arbitraire/nested, formes malformées, succès/effets forgés, champs privés inconnus, données sensibles/immutabilité et projection bornée indépendante de 50 000 éléments étrangers, codes courts désignés sur tous les champs visibles, nombres non secrets préservés et détachement de la projection après mutation de l'entrée. CI : `test-voice-receipt-metadata.cjs`. TypeScript compile. Test local : 1 000 projections sous 1 seconde, plafond de régression pure et non budget de route S24.

Aucune route nouvelle ni route active modifiée, aucune capability nouvelle, aucun appel Gateway, paiement, réseau ou stockage. `companion-acceptance.py` reste inchangé : ajouter une ligne de recette ou simuler une route active maintenant serait une preuve fictive. Les budgets des deux routes voix et du relais doivent être confirmés puis vérifiés lors du vrai branchement.

## Blocages avant branchement et qualification

- Captures réelles nettoyées de succès, erreur, CLARIFY et run en cours via les propriétaires live/relais ; provenance et latences incluses (core #124, à compléter quand GitHub est disponible).
- HS3 doit être relu/qualifié ; la base de cette préparation est `f25dbf042ffc6c470ccc1f2c4ba23faa4adab40e` (la note conserve le SHA réellement calculé).
- Formes propriétaires et captures HS4/HS5 pour `clarification`/`progress`, sans reconstruire les étapes depuis des événements ambigus.
- Décision sur la source canonique de langue du tour : `clawLiveWarm` conserve une locale, mais les réponses capability/decision et le relais n'en fournissent pas un lien qualifié avec le résultat. Aucun paramètre HTTP inventé ni locale par défaut ajouté.

État : préparation Draft, merge_eligibility blocked, aucun déploiement. Retour arrière : retirer l'adaptateur et son test ; aucune donnée runtime à restaurer.

## Suite piste 2 du 11 octobre — périmètre vérifiable

Le runtime et les captures fusionnées de core #129/#131 sont maintenant intégrés
par merge. Les décisions et enveloppes terminales de #129 sont utilisées dans les
tests. Elles ne contiennent pas de présentations HS3 voix qualifiées : ce manque
précis remplace la demande obsolète de captures générales dans la préparation.

`planVoiceReceiptSpeech` prépare « J’ai compris » pour transaction, CLARIFY et
lecture sous 0,8 (ou confiance absente). Il ne lit que `understood` validé ; aucune
capability ou paramètre brut n’est transformé en parole sans présentation. Sur
échec, il prononce exclusivement `failure.step` et `failure.reason`, jamais une
assurance de non-débit déduite du statut. `effect.debited` reste inconnu.

V3 est raccordé au résultat déterministe existant du relais : enveloppe directe du
propriétaire capability uniquement, langue de la présentation conservée, aucune
langue utilisateur déduite. L’erreur garde `success=false/state=failed`; elle ne
retombe pas vers l’agent et n’est pas rejouée. Aucun endpoint ajouté, aucun appel
supplémentaire. La ligne de recette du relais reste son contrat existant ; budget
pur <1 seconde pour 1000 projections, recette de latence voix S24 encore requise.

V1 reste une préparation : Live transmet le résultat au modèle Gemini après
exécution ; un prompt ne garantit ni le verbatim ni une parole *avant* transaction.
Raccorder nécessite le propriétaire de rendu audio et une phase préexécution
qualifiés ; ni le parcours paiement ni son admission ne sont modifiés ici.

V2 fournit une liste versionnée FR/EN/derja et un détecteur exact valable 120 s,
sans persistance. La derja est `authored`, non fournie par Amine. Le propriétaire
C2 partagé avec le bouton et son signal `engineering.learning_gate capture-round`
sont absents de cette base : le détecteur n’est donc pas activé, aucun store ou
signal parallèle n’est ajouté. Ce lot ne déclare pas V1/V2 terminés.

Recette guidée Claude : (1) activer seulement après relecture HS3 ; (2) obtenir un
résultat déterministe en erreur avec présentation HS3 et vérifier l’étape/raison
verbatim et `failed`, sans relance agent ; (3) résultat lecture sans présentation :
conserver le rendu existant ; (4) vérifier absence de logs audio/transcriptions ;
(5) relever budget live/relais réel avant de qualifier V3. Pour V1, vérifier un
événement de parole attesté avant l’effet, pas seulement un toolResponse JSON.
Retour arrière de cette suite : revert du commit de suite (projection et raccord
relais), aucune donnée ou migration runtime.
