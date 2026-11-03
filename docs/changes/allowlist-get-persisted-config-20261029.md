# Accès WhatsApp : lecture d'un contact sans relancer OpenClaw (29/10/2026)

Lire l'accès d'un contact prenait 2 à 3 s sur le S24 : 2 s servaient à lancer la commande `openclaw gateway call` pour récupérer la configuration. Python et la lecture des contacts prennent 50 ms.

La lecture « get » (entrée de la pièce Pulse, fiche contact de l'app) lit maintenant le fichier de configuration lui-même, avec les mêmes contrôles que la lecture native de la pièce Pulse. Sur le S24, les deux sources donnent les mêmes lignes pour les 5 contacts (22 ms au lieu de 2,41 s). Les modifications d'accès gardent la configuration en direct de la passerelle.

Décision d'Amine, 29/10 : « go lecture en mémoire aussi ».
