# Pièce Pulse : un message reçu pendant un redémarrage est gardé — 28 octobre 2026

Le 28/10 à 16:05, Sadok a écrit pendant que Samantha redémarrait après un déploiement. Le service d'interprétation n'était pas encore prêt, et la pièce a répondu « … n'a pas abouti. Aucun nouvel essai automatique n'est lancé. » Samantha était prête 14 secondes plus tard.

Décision d'Amine du 28/10 : un message reçu pendant une mise à jour est gardé et traité après le redémarrage.

Maintenant, quand le coordinateur répond « à reprendre » (aucun modèle atteint, rien exécuté), la pièce attend 5 secondes et soumet le même message à nouveau, jusqu'à ce que Samantha soit prête (5 minutes au plus). La réponse part ensuite normalement. Au-delà, la pièce dit que Samantha redémarre encore et que rien n'a été exécuté.

OpenClaw 2026.9.6 n'impose pas de délai à ce hook : l'attente ne peut pas faire passer le message au modèle généraliste. Une vraie erreur n'est jamais soumise à nouveau.

Retour arrière : revert de ce commit, puis redéploiement par `companion-deploy.sh`.
