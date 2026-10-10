# HS3 — Transport validé de présentation générique

**Brouillon : preuve finale des familles métier absente, issue core #124.** Ce lot transporte la projection metadata du Graph playbooks HS3 (PR #72) jusqu’au run Companion existant et son GET. Aucun fichier de paiement, confirmation, executor ou app n’est modifié. Aucun nouveau store, route ou routeur.

## Chemin réel

Le Graph renvoie presentation/understood/failure/alternatives. model-fast-path.py conserve une présentation **validée** au lieu de sélectionner seulement execution.result ; son rendu préfère titre puis spoken. Sans présentation valide, le comportement existant reste inchangé (ce lot ne prétend pas avoir supprimé tout ancien repli JSON O7). Les paramètres signés/decision/execution.result ne sont pas recalculés.

intent.executeCapabilityFirst transmet les métadonnées fermées à settleSubmittedRun. Le propriétaire runs.json existant garde uniquement presentation bornée ; statusFromStoredRun et la relecture du fichier la valident à nouveau puis exposent aussi understood/failure/alternatives. Les soumissions rejouées retournent les mêmes métadonnées. Une réservation en cours reçoit un repli générique, sans paramètres déduits ; aucun effet affirmé. Le parcours Gateway historique ne reçoit pas de faux rendu métier.

## Sous-contrat accepté

Version 1, locale fr/en, status **info/error** uniquement, label/title ≤200, spoken ≤240, rows vide, primary done. understood contient capability id|null, label et seulement operator=orange|tt|zain et line=owner. alternatives ≤3 capabilities uniques, différentes de la sélection, dans l’ordre reçu. failure en erreur contient step ≤200 et reason ≤240. meta ne contient que capability. Aucun montant, bénéficiaire, E.164, nonce, hash, nom ou paramètre libre n’est transporté depuis les slots.

La lecture ignore les champs inconnus et rejette les formes mal typées ou sensibles ; Python réutilise le filtre LEAK acceptance existant, complété pour préfixes de clé et numéros segmentés. Le lecteur TypeScript valide de nouveau à la frontière de stockage/relecture. Aucun stderr ni exception brute n’est utilisé comme failure. Le repli dit « résultat à vérifier » ou « demande non aboutie », jamais « payé », « traité avec succès » ou « aucun débit ».

L’effet accepté est **unknown seulement**. Même state=failed/cancelled/confirmed ou un objet debited=false ne constitue pas une preuve publique de débit. Les formateurs de succès métier, lignes chiffrées, autres actions et toute preuve financière nécessitent les captures propriétaires et une revue séparée de cette extension ; aucun nouveau champ paiement n’est inventé.

## Vérification et limites

Tests de formes metadata générées explicites (pas captures S24), traitement privé/type/effet négatif, préférence presentation et maintien du repli legacy ; vrai chemin submitIntent avec helper simulé → propriétaire runs.json isolé → GET HTTP /v1/runs/{id} → processus neuf/relecture ; rejouer clientRunId conserve la présentation. Une présentation sensible stockée est rejetée. Aucun fournisseur, téléphone ou paiement exécuté.

Build, tests Python HS3, tests HTTP/persistance HS3, fastpath plugin, composed read, durable fastpath, Companion runs et delete-run passent. Nouveaux tests ajoutés à ci.yml par union. GET détail run existant : plafond de régression local de 4 s, choisi pour ce test, sans prétendre que ce détail possède la ligne READS de la liste /runs?limit=50 ; pas qualification de latence S24 ; aucune route ni ligne acceptance inventée. Les captures réelles de présentation attendues dans core #124 restent obligatoires. Le reçu historique playbooks O7 ne qualifie pas les familles ou le transport complet S24.

Le snapshot signé de décision actuel omet shortlist : alternatives peut être vide sur l’exécution préparée. Le contrat signé n’est pas modifié ; aucune autre liste calculée localement. Slots canoniques pas encore prouvés : vides par défaut. Locale Graph fr par défaut tant que le demandeur ne transmet pas en ; pas de réglage de langue runtime inventé. Les rendus app sont suivis séparément par HA3.

Activation : Claude seulement, après playbooks #72 et qualification du helper/reader déployés ensemble (receipt-presentation-read.py et companion-acceptance.py présents avec model-fast-path.py). Retour arrière : revert des métadonnées et readers ; les anciens runs restent lisibles, aucun état métier ou paiement à restaurer.
