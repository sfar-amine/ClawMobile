# L3 — Gabarit core vérifié en CI

La CI core vérifie les sections exactes de son propre modèle de PR dans le
payload GitHub. Pas de lecture inter-dépôts ni d’exécution ou affichage du corps.
Les étapes existantes sont conservées et les permissions restent inchangées.

La grâce est commune à la jumelle playbooks : du 11 octobre 2026 00:00 UTC au
18 octobre 2026 00:00 UTC ; ensuite le contrôle devient bloquant. Dix tests
sur payloads GitHub générés passent, y compris le titre `Retour arrière` du core.
Aucun runtime ni paiement modifié, aucune activation S24.
