# Clôture voix — Companion (18/10)

**Constat (banc voix S24 et essais d'Amine du 18/10).**
- Factures à la voix : « 0,985 TND » sans nommer STEG ; « c'est quel fournisseur ? » n'avait pas de réponse.
- Phrase mal transcrite (« on se dérange » pour « mon solde orange ») : « J'ai compris : Demande. Ça n'a pas abouti à l'étape « Compréhension de la demande » : la cause n'est pas établie par le reçu. »
- Une exécution non admise rendait la relecture du reçu « non admissible » : erreur de protocole, appel fermé (« la réponse est arrivée incomplète »).
- « la météo à Tunis demain » : `web_deadline_exceeded` deux fois de suite (17,2 s) ; recherche seule 5,6–8,4 s, synthèse ≈ 6 s.

**Correctifs.**
- `planVoiceSpeech` : sur une lecture vérifiée (ni échec, ni transaction, ni précision), la forme parlée du propriétaire (`result.speech`, ≤ 600 caractères, sans caractère de contrôle) est imposée mot pour mot. Les factures (playbooks #218) disent ainsi chaque fournisseur.
- `planVoiceSpeech` : un échec à l'étape « Compréhension de la demande » sans cause établie et sans capacité devient « Je n'ai pas bien compris. Tu peux reformuler ? ».
- `VoiceTurnProtocol.receiptReply` : sans exécution admise (ou tour interrompu, ou sortie encore ouverte), refus explicite `receiptRefused` pour ce tour, sans rendre la session ambiguë ; l'app (PR jumelle) l'affiche et reprend l'écoute.
- `PUBLIC_WEB_BUDGET_MS` et ses bornes Python passent de 20 000 à 30 000 ms.

**Activation.** Playbooks d'abord (ils acceptent 30 s), puis ce core, puis l'APK. Recette : grille du banc voix sur le S24.
