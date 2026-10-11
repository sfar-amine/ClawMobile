# P1 — Gateway public isolé local

Preuve locale, distincte des captures S24 #172. OpenClaw public 2026.9.6 lancé avec Node 26, profil/configuration/état/ports loopback et jeton générés pour cet essai puis détruits. Environnement enfant construit par liste autorisée ; aucun jeton S24, secret de compte ou appareil Android utilisé.

Le fournisseur modèle est un serveur HTTP déterministe loopback, et le plugin probe est synthétique. Les métadonnées hôte montrent les effets réellement exécutés, leur bit owner et le contrôle `assertInvocationCurrent`. La transcription et les contenus métier ne sont pas conservés.

La preuve passe cinq vérifications : owner/non-owner, effet du tour accepté malgré révocation puis tour suivant non-owner, annulation admin avec invocation fermée avant effet, et CLARIFY HTTP signé qui abandonne la clarification tierce sans la résoudre. Les essais antérieurs sont archivés dans les artefacts locaux ; cet essai est `run-07.log`. L’annulation par une autre connexion write était refusée `unauthorized`.

La fenêtre bootstrap/handshake avant ACK reste bloquante : la façade publique ne transmet pas `assertDispatchCurrent` ou `onAccepted`. Une CI verte ne qualifie pas cette fenêtre ni l’annulation depuis l’app. Le checksum des scripts et celui de la preuve originelle figurent dans le JSON.
