# Pièce Pulse : retrait du bail Gateway (29/10/2026)

Chaque message d'un contact de la pièce Pulse était contrôlé trois fois : à l'entrée de la pièce (`NativePulseContact`), côté Python (preuve scellée relue à chaque envoi), puis une troisième fois par la Gateway (bail d'invocation et nouvelle relecture de l'allowlist). Ce troisième contrôle refusait tous les messages sur le S24 (28/10 15:06, 29/10 16:28, Sadok) en 3 ms, avant tout appel au modèle.

Il est retiré (Amine, 29/10 : « supprimer les contraintes superflues »). La Gateway garde le seul profil Gemini admis (DATA01) et une requête limitée au catalogue Pulse. La table des échecs de la pièce nomme « le modèle n'est pas joignable » et « deux messages se sont croisés » au lieu du texte générique.

Ordre : playbooks #346 actif d'abord, puis ce déploiement core.
