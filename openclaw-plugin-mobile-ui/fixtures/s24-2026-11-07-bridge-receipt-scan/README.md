# S24 07/11/2026 — Remote Bridge : chaque requête relisait tous les reçus

Capture en lecture seule sur le S24, `scan-and-freeze.json` :

- **Répertoire des reçus.** `~/.openclaw/remote-bridge/requests` contient 57 664 fichiers (148 Mo de contenu, 305 Mo sur disque). Le plus ancien a 39,7 jours. 13 303 reçus portent une tâche et une étape. Le fichier donne aussi la répartition par méthode, par état et par risque.
  - La rétention actuelle garde 50 000 reçus de lecture.
  - Elle conserve sans limite les reçus d'écriture et ceux dont l'effet est inconnu.
- **Coût d'un passage synchrone.** Avec le Node de la passerelle, lire et analyser tous les reçus prend 1 202 ms (cache disque chaud). C'est ce que faisaient `findTaskStepReceipt` à chaque nouvelle étape et `getRemoteBridgeTask` à chaque `task_status`.
- **Sonde (`sampler`).** Toutes les 0,3 s : latence de `GET /v1/extensions/claw-live/warm-status`, état du processus Companion, temps CPU utilisateur et système.
  - On y voit des arrêts de 0,8 à 2 s (`000` = aucune réponse en 2 s).
  - Pendant ces arrêts, le Companion est en calcul (`R`) ou en attente disque (`D`), avec un fort temps système.
  - Les arrêts coïncident avec les commandes passées au S24 par le Remote Bridge.
- **Journal.** La ligne `abandon sweep … scanned=10179` montre la même lecture de masse au démarrage, le 18/10.

Effet observé le même jour (fixture `s24-2026-11-07-orange-app-surface`) : environ 40 s sans réponse HTTP pendant un tour écrit, et l'outil Orange retombait sur la surface voix.

Aucun numéro, contenu de commande ni secret. Utilisée par `scripts/test-remote-bridge-receipt-index.cjs`.
