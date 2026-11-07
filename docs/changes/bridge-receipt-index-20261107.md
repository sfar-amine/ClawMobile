# Remote Bridge : plus de relecture de tous les reçus à chaque requête

**Constat (S24, 07/11).**
- Le répertoire des reçus du Remote Bridge contient 57 664 fichiers, sur 40 jours.
- Chaque nouvelle étape et chaque `task_status` les relisaient tous, de façon synchrone : 1,2 s à cache chaud, davantage quand le disque est sollicité.
- Pendant ce temps, le Companion ne répondait à rien : ni à l'app, ni à l'outil Orange, ni aux commandes S24.
- Mesures :
  - arrêts répétés de 0,8 à 2 s, processus en calcul ou en attente disque ;
  - environ 40 s sans réponse pendant un tour écrit.

**Correctif.**
- Un index en mémoire, tâche/étape vers reçu, est construit une fois par démarrage, de façon asynchrone, par petits lots.
- Il est mis à jour à chaque écriture de reçu.
- Une requête lit uniquement le reçu concerné.
- L'idempotence est inchangée :
  - la vérification de l'étape et l'écriture du reçu qui la réserve restent une seule section synchrone ;
  - deux demandes simultanées de la même étape ne l'exécutent qu'une fois ;
  - une étape déjà exécutée est rejouée depuis son reçu.

**Preuve.** `scripts/test-remote-bridge-receipt-index.cjs`, avec le volume réel du S24 :
- avec l'index : pause maximale de la boucle de 4 ms pendant la construction, 0 ms par requête ;
- avec l'ancien code : le même test échoue (pause de 425 ms).

**Hors champ.** La croissance du répertoire n'est pas traitée ici : les reçus d'écriture et ceux dont l'effet est inconnu n'expirent jamais. La rétention est une décision séparée.
