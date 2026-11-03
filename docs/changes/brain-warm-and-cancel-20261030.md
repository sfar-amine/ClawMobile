# Premier message sans démarrage à froid, « Annule » nommé (30/10/2026)

- **Démarrage à froid.** Après chaque démarrage de la Gateway, le premier tour du cerveau propriétaire la bloquait
  41 à 62 s (WhatsApp coupé puis reconnecté), puis chargeait les outils des plugins 8 à 10 s ; le tour suivant était
  chaud (8,2 s). `brain-warm.py` fait ce premier tour juste après le démarrage (lancé par `gateway-start.sh`,
  attendu par le déploiement avant les 5 parcours), dans la session dédiée `agent:main:brain-warm`, sans outil ni
  envoi. Un tour par processus Gateway, sans nouvel essai ; reçu : `~/.openclaw/health/brain-warm.json`.
- **« Annule » côté propriétaire.** La description de l'outil typé dit qu'un refus ou une annulation du récapitulatif
  est un appel `cancel` avec les mêmes valeurs (PR playbooks jumelle : le reçu du récapitulatif le dit aussi).
- **« Annule » dans la pièce Pulse.** Un refus d'interprétation s'affiche avec sa propre phrase (« Je n'ai pas compris
  ta réponse de façon fiable… ») au lieu de « n'a pas abouti » ; la cause elle-même est corrigée côté playbooks.
