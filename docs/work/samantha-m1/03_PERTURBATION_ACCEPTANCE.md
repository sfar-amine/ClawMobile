# A13 — perturbations : preuves automatisées et recette physique restante

Les six tests test-voice-m1-disturbances.cjs sont des simulations déterministes du owner Warm existant : détachement pendant setup, token tardif après changement de session, remplacement du processus owner, output d'un ancien provider, exécution admise conservée sans rejeu, panne de la sonde CLOCK_BOOTTIME. Ils n'exécutent aucune commande Android et ne prouvent pas un reboot, une mise à jour APK ou la récupération ADB sur S24.

## Réutilisation du harness canonique

Claude possède android/samantha/tools/lot0_harness.py (source Phase 0 e5bd3a4a60e5eae1492dd3b9899e288431f55126). Ce lot ne modifie pas ce fichier ni la branche Android. Les mesures cold/warm, force-stop, export C1 et restauration du premier plan appartiennent à ce harness. Aucun nouvel orchestrateur, scheduler, retry engine ou mécanisme de reprise n'est ajouté.

## Scénarios physiques à réserver dans le checkpoint existant

| Scénario | Avant effet | Vérification attendue après effet |
|---|---|---|
| Force-stop de Samantha | Créneau exclusif, versions/hashes, aucune action sensible en cours, foreground connu | Relance par harness ; nouveau sid app, WarmReady v2, absence d'ancien audio/outcome rejoué, état des demandes inchangé sauf résultat réel |
| Reboot et retour ADB | Checkpoint durable, activité sensible absente, ancien APK/runtime restaurables, Amine disponible pour premier déverrouillage | Nouveau boot_id observé, endpoint ADB canonique réellement prêt, health/runtime/Voice relus ; la simple reconnexion réseau ne vaut pas readiness |
| Mise à jour in place | APK de rollback exact et hash, signatures compatibles, versionCode observé, données conservées, gate d'installation autorisé | APK/version réellement installées, conversations et reçus conservés, pas de nouvel effet, même identité de run après ACK perdu, Voice/Control vérifiés par harness |
| ADB indisponible | Snapshot du contexte et simulation autorisée selon route de panne existante | Indisponibilité explicite, aucune conclusion « app absente », aucune boucle de retry infinie ; reprise seulement après readiness revalidée |

Ces lignes décrivent les recettes à exécuter par la session connectée au S24. Elles ne donnent pas une autorisation de mutation depuis le cloud. Pour chaque effet utiliser les taskId/stepId/requestId du checkpoint existant ; si un effet est indéterminé, lire le reçu et vérifier avant tout retry. Conserver les preuves de restauration et le foreground final, jamais un simple exit code de cleanup.

## Blocage concret

Aucun outil Claw/ADB S24 authentifié n'est exposé dans cette session. Le checkpoint d28b0f37… n'a été fourni que comme référence, sans reçu consultable depuis le cloud. A13 reste donc PHYSICAL_ACCEPTANCE_PENDING ; l'acquittement 0.4 et le gate M1 ne sont pas écrits dans S24 ici. Le script de test annonce explicitement physicalReboot=false, physicalUpdate=false et physicalAdb=false.
