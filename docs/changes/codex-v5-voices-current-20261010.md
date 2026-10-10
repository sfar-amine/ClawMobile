# V5 — choix de voix sans persistance runtime

Le fichier 23 remplace le stockage et la mutation de préférences Companion du fichier 18. GET /v1/voice/voices retourne le catalogue candidat et ses flags ; la préférence Android est transmise au token ou au bootstrap natif existants. Absence/null conserve le setup exact ; inconnue renvoie 400 avant effet. La connexion active garde sa voix, même pendant une reprise ; la session suivante peut en adopter une autre.

CI locale courante et nouvelles preuves HTTP/WebSocket/setups passent, avec régressions warm/detach/cancellation. Aucune modification ci.yml, paiement, route audio ou modèle. Aucun déploiement ni test fournisseur/S24 : les huit candidats sont non qualifiés ; Claude effectue setupComplete sans audio, retire les refusés avant activation puis fait la recette acoustique et de latence avec Amine.
