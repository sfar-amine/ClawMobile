# Samantha barge-in — candidat du 6 octobre 2026

Tâche : `samantha-barge-in-implementation-20261006`. Version candidate : `0.8.0-barge-in-candidate`.
**État : code candidat compilé ; recette physique et qualification provider incomplètes. Aucun déploiement ni clôture fonctionnelle.**

## Modifications réalisées

L’application réutilise `LiveVoiceSession`, `SessionAudio`, `VoiceEvidenceGate` et l’historique existants. La capture en mode communication, l’AEC liée à la session AudioRecord, le VAD Silero local, le prébuffer indexé de 300 ms et la coupure prioritaire sont intégrés dans le candidat. Les anciennes générations audio et les reçus tardifs sont isolés par tour. Une phrase dont le début a été perdu n’est pas exécutée comme un suffixe.

Companion porte une extension versionnée du socket Warm existant : un propriétaire d’écriture, indices audio, contrôles idempotents, attribution des sorties et admission des capacités. Aucun nouveau routeur, service, scheduler, mémoire ou moteur de reprise n’est ajouté. L’historique accepte des métadonnées de lecture distinctes de la génération ; aucun découpage mot/audio inventé.

Le mode automatique est désactivé par défaut. Une configuration canonique exige une route audio qualifiée et un modèle de protocole qualifié. La configuration active n’a pas été modifiée. Les corrections Warm et le repli Sol/Luna/Gemini existants restent inchangés sur le téléphone.

## Dépendances et provenance

`android-vad-silero` 2.0.10, source `1b006d0aaf8fa269986a8c95a196055550c9b877`, est figé avec son empreinte et ses licences dans `android/samantha/app/libs/`. ONNX Runtime Android 1.22.0 est utilisé avec les paramètres du modèle. L’APK candidat cible arm64-v8a. Le modèle est initialisé hors du démarrage immédiat du microphone.

La discipline de propriété audio s’appuie sur OpenClaw, révision `8bee14300743248f2ab4583b898e7a01789dc4e1` : `AndroidAudioInputSession` et `RealtimeCommunicationAudio`. Attribution et licence MIT conservées. La fixture vocale est une ressource de test du projet android-vad, pas une prise de son d’Amine.

## Résultats vérifiés

- Application et APK d’instrumentation : compilation réussie.
- JVM : **65 tests, zéro échec, zéro erreur, zéro test ignoré**.
- Lint : **zéro erreur ; 56 avertissements** conservés, non masqués.
- Protocole : **13 scénarios déterministes réussis**.
- Propriété Warm v2, métadonnées de lecture et déduplication : tests réussis.
- Régressions existantes Warm, annulation Warm, historique Companion, Claw Live et MCP : réussies.
- Cinq tests Android physiques sont écrits et compilés, mais **n’ont pas été exécutés**.

Les journaux, canaries et empreintes sont sous `~/.openclaw/backups/samantha-barge-in-20261006/`. Les résultats d’un premier build ne remplacent pas ceux du build final. Aucun résultat acoustique n’est déduit de ces tests déterministes.

## Réserve déterminante : fin de transcription

La spécification v0.1 et le SDK exposent un champ optionnel `inputTranscription.finished`. Les deux canaries réels sur le modèle configuré `gemini-3.8-live` ont reçu `inputTranscription.text`, mais pas ce marqueur. Le second essai demandait aussi le mode verbatim et les horodatages : la frontière n’est toujours pas démontrée.

Il ne s’agit ni d’un rate limit ni d’une panne STT démontrée : des textes et de l’audio sont reçus. C’est l’hypothèse de corrélation de la spécification qui reste non qualifiée. Le protocole strict refuse de transmettre/exécuter le tour suivant sur une simple supposition temporelle. Les deux canaries sont conservés comme résultats négatifs de qualification, jamais comme recettes réussies.

Référence : `https://ai.google.dev/api/live`. La transcription est indépendante des autres messages et l’ordre relatif n’est pas garanti. Le guide `https://ai.google.dev/gemini-api/docs/live-api/live-transcribe` décrit également un autre mode dédié à la transcription ; il ne prouve pas la présence du marqueur sur notre modèle conversationnel. Aucun provider ou coût supplémentaire n’a été introduit pour faire passer le test.

Avant activation : établir un contrat de corrélation réellement supporté, puis le vérifier avec retards, interruptions successives et sorties tardives. Une évolution nécessitant une autre chaîne de reconnaissance doit être explicitée, pas intégrée silencieusement. Ne pas supprimer ce garde, attendre un délai arbitraire ou déclarer un fragment final pour obtenir un résultat positif.

## Recette physique en attente

Le S24 est protégé par le verrouillage sécurisé au moment de la recette. Le microphone n’a pas été ouvert et aucune tentative de déverrouillage n’a été faite. Les cinq tests couvrent AEC native, inférence Silero réelle, purge AudioTrack, coupure sur prise de parole contrôlée et reçu tardif. Même une réussite de ces tests ne constituerait pas encore la campagne de véritable chevauchement acoustique avec la voix d’Amine.

## Incident de transport distinct

RDC a perdu son canal pendant le build, avec `IncreaseConnectionPool: Please increase your connection pool size`. Le build a continué et terminé. Slack a servi uniquement à récupérer son résultat et observer la réparation canonique ; aucune modification applicative n’a été rejouée par le canal de secours. RDC a ensuite répondu au ping distant et à la vérification singleton/MCP/heartbeat. Incident `b82b80bc2b5154c19307`, récupération liée `d54ee94932b12a2acde2`. Cela ne certifie pas le barge-in.

## Publication, activation et retour arrière

Les sources sont conservées dans des branches candidates distinctes. `merge_eligibility=blocked` interdit leur promotion automatique sur main ; la publication d’une branche de travail n’est pas une installation. La version active reste **0.7.1-native-dev**.

Aucune migration de l’historique actif ni modification du profil audio n’a été effectuée. Le retour arrière actuel ne nécessite aucune réinstallation. Lors d’une recette ultérieure, sauvegarder/vérifier l’APK installé et le propriétaire UI avant installation du candidat, utiliser le mécanisme de recette existant et restaurer explicitement la version précédente si la qualification n’aboutit pas. Ne pas réinstaller ou rejouer les tests terminés uniquement pour reprendre le chantier.

## Conditions de clôture encore ouvertes

1. Contrat provider de corrélation validé sans heuristique fragile.
2. Tests natifs sur S24 déverrouillé et vérification de libération des ressources.
3. Véritable chevauchement acoustique, mesures de faux déclenchements et de latence.
4. Revue finale des courses focus/route/mute et isolation des demandes, non-régression finale.
5. Promotion, activation contrôlée, recette live, nettoyage et clôture via les reçus canoniques.
