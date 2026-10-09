# A12 — protocole RDV1, brouillon pour coordination M1

Livrable A12 préparé pour revue ; aucune séance physique exécutée. Ne vaut ni réservation physique S24 ni notification du RDV1. Le gate M1 doit être validé par les deux checkpoints avant séance. À rapprocher du protocole existant de la branche active A8–A13 avant adoption ; ne pas créer de second harness.

## Avant la séance

1. Vérifier le checkpoint courant, ownership physique exclusif et consentement d'Amine pour la séance. Téléphone déverrouillé par Amine ; ne pas contourner la sécurité.
2. Figer les SHA app/Companion, APK et hash, versions du corpus/analyseur et commande du harness existant. Préserver APK/runtime de rollback.
3. Vérifier pièce calme, enregistreur externe unique, consentement et stockage privé de l'enregistrement hors Git/logs/mémoire. Les mesures externes restent séparées de la télémétrie technique.
4. Réaliser un essai à blanc : un sid et turn recollés, flags t00, chaîne complète jusqu'au frame joué t32 ; alignement onset audible/t32, contrôle arrêt audible/t43. Refuser les métriques si le contrôle échoue.
5. Reporter dans la feuille de séance volume, distance, position, niveau sonore et état réseau effectivement choisis par Amine ; garder ces conditions identiques entre groupes comparés. Aucun nombre arbitraire déclaré comme condition canonique.

## Déroulé indicatif, arrêt/reprise possible

- 0–15 min : versions, conditions, essai à blanc et vérification des artefacts.
- 15–45 min : baseline 0.10.1, tous cas du corpus ; mêmes stimuli et répétitions consignées.
- 45–110 min : A/B par facteur, selon ordre contrebalancé documenté avant collecte. Baseline : NS off, endpointing silero, min_speech_frames=3, bargein on. Tester NS on/off. Le runtime de cette livraison refuse explicitement endpointing=provider (warmError endpointing_not_supported, close 1008) : ne pas le mesurer comme un groupe Silero ni prétendre faire cet A/B avant une livraison qualifiée ; choix des autres niveaux 1–6 seulement selon plan A/B approuvé. Changer les flags entre sessions, jamais en cours de session. Ne pas cumuler des changements sans groupe de contrôle.
- 110–150 min : interruptions vraies/fausses et conversation naturelle sur script identique ; compléter le nombre nécessaire, ou déclarer la séance partielle plutôt qu'inventer une couverture.
- Fin : export par le harness existant, vérification des artefacts, libération du créneau physique et checkpoint de résultats par l'assistant connecté au S24.

Ces temps sont un budget indicatif ; la couverture et le N requis priment. Prévoir une extension/RDV1bis si le corpus et N >= 100 interruptions ne tiennent pas dans la séance. Ne pas garantir P95 par configuration si les échantillons sont répartis entre plusieurs configurations et chacune a N < 100.

## Feuille de mesure minimale

Cas corpus, configuration, ordre, sid/turn, condition cold/warm/reconnect, résultat attendu/observé, référence artefact, annotations externes t20/t23/t40, chaîne t21/t25/t32/t41/t43, événement manquant, faux positif, interruption manquée, anomalie réseau et perception d'Amine. Aucun audio, transcript ou secret dans les événements C1 ni les checkpoints.

## Sortie attendue

- T_response, BargeDetect, BargeCut, BargeE2E avec unité, N, exclusions, p50/p90/max ; p95 uniquement quand l'effectif du groupe le justifie.
- Taux faux positifs et interruptions manquées avec dénominateurs, pas de silence assimilé à une réussite.
- REQ-1652 et invariants d'action conservés ; aucun effet financier ou sensible lancé pour la mesure.
- Décisions de flags uniquement sur preuves et décision propriétaire, aucune bascule runtime automatique depuis ce protocole.
- Gate en échec : conserver les preuves, relever le point exact, reprogrammer seulement la partie invalide. Gate validé : transmettre les résultats à l'intégrateur selon les checkpoints existants.

## Activation et qualification A8 préalables

- Le recorder Companion est désactivé par défaut. L’activation de CLAW_VOICE_TELEMETRY=1 et le redémarrage éventuel appartiennent à la livraison runtime contrôlée S24, avec snapshot/restauration selon les mécanismes existants. Aucune activation n’a été faite depuis le cloud.
- Les événements sont horodatés par un appel réel Python CLOCK_BOOTTIME, sans substitution MONOTONIC. Le coût de la sonde synchrone est observable dans x.clock_probe_us et le status Warm telemetry.maxProbeUs ; mesurer aussi l’effet sur les étapes de transport, sans soustraire automatiquement ce coût. Le recorder est un mode de laboratoire, pas une promesse de télémétrie sans perturbation. Une sonde/disk en échec ferme le recorder pour sa durée de vie ; la Voice continue et les données manquantes interdisent la recette complète.
- Sur une connexion froide attachée en v2, t01–t07 sont joints au sid app. Un prewarm global sans sid ne fabrique aucune identité app ; si le provider était déjà connecté, les étapes t02–t06 manquantes ne sont pas recréées. Pour la baseline cold, utiliser le reset déjà possédé par le Warm/harness dans le créneau S24 autorisé.
- t25p/t30p/t44 suivent les tours v2 admis, avec x.connection pour l’audit de génération. Un reconnect qui empêche la correspondance sid/turn doit être traité comme échantillon incomplet et vérifié contre les logs app ; aucune corrélation artificielle.
- A10 actuellement livré fournit la décomposition interne uniquement. Les KPI externes exigent encore les annotations/enregistrements alignés : ne pas annoncer t32-t23 comme une sortie actuelle de l’analyseur.
