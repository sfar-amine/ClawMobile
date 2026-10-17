# HS8 — qualification S24 du mémo vocal (17/10/2026)

Reçu de qualification du propriétaire STT canonique (`memoSttOwner.runMemoAudioOwner`, SDK OpenClaw 2026.9.6 installé, Gemini `gemini-3.5-flash-lite`, profil gratuit `google:claw-gemini-free`). `memoSttBoundary.qualifyMemoStt` lit ce reçu (copie `src/companion/memoSttQualificationReceipt.ts`, égalité vérifiée en CI) ; toute différence de modèle, profil, version SDK, prompt, fournisseur de repli ou conteneur referme l'entrée.

| Fichier | Contenu |
|---|---|
| `qualification-receipt.json` | Reçu nettoyé : configuration (métadonnées seulement, aucune clé), préflight d'auth verrouillé, trois transcriptions du M4A mp42 et une du M4A #174, tentatives fournisseur, confidentialité des journaux, limites. |
| `memo-fr-synthetic.m4a` | « Bonjour Samantha, ceci est un test. » : espeak-ng puis ffmpeg, AAC LC 16 kHz mono, marque `mp42`/`isom` comme `MediaRecorder` (`VoiceMemo.kt`). Synthétisé hors S24, aucune voix humaine ni donnée personnelle. SHA256 `a1105052…ac19b`. |
| `probe-owner.cjs.txt` | Sonde exécutée sur le S24 (lecture seule) : charge le `dist/companion` installé, aucun run, aucune route, aucune écriture runtime. |

## Méthode

1. Diagnostic S24 en lecture : runtime `636becf5`, `dist/companion/memoSttOwner.js` présent, garde déployé fermé (`memo_stt_not_qualified`), SDK `openclaw` 2026.9.6 sous `npm root -g`, Termux:API a maintenant `RECORD_AUDIO` (non utilisé).
2. M4A poussé dans `~/.openclaw/tmp/memo-qual-20261017` (SHA vérifié), sonde lancée avec le binaire glibc, le cwd et l'environnement exacts du process Companion (`/proc/<pid>/environ`, `env -i`).
3. Résultat : préflight `google:claw-gemini-free` / `api-key` (306 ms), 4 transcriptions sur 4, chaque tentative `google/gemini-3.5-flash-lite` sans repli, 1,3 à 3,4 s par mémo ; chargement SDK à froid 7,3 s (hors chemin POST, asynchrone).
4. Journaux : aucun fichier hors reçus Claw de ces commandes ne contient le texte transcrit ni le nom du fichier.
5. Dossier temporaire supprimé.

## Limites (recette Amine requise)

La voix espeak-ng est robotique : « Bonjour » est mal reconnu sur les trois essais, la fin de phrase est exacte. La précision sur voix humaine (français, derja en arabizi), le vrai fichier du recorder Android, le parcours HTTP complet avec admission P1 de l'app et les journaux du process Companion restent à constater en recette réelle.
