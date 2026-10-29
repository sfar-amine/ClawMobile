# Pièce Pulse : un seul contrôle d'accès par message (29/10/2026)

Chaque étape d'un message de la pièce Pulse relisait l'accès du contact en relançant le propriétaire des contacts (2 à 3 s sur le S24). Une écriture complète en faisait 11.

L'accès est maintenant lu une fois à l'entrée du message et réutilisé par ses étapes pendant 60 s. Chaque étape revérifie la valeur lue (pièce, état, numéro, expiration). Un accès retiré bloque le message suivant ; un message qui attend plus de 60 s relit l'accès. Une lecture en échec n'est jamais réutilisée.

Décision d'Amine, 29/10 : un contrôle par message, pas à chaque étape.
