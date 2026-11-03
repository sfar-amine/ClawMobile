# Plus de réouverture automatique de ChatGPT — 29 octobre 2026

Amine, le 29/10 : ChatGPT revenait sans cesse au premier plan sur le S24.

Cause relevée sur le S24 : `chat-continuity-restore.sh` rouvrait une conversation ChatGPT enregistrée le 26/09. Il le faisait à chaque reconnexion ADB (watchdog ADB et gestionnaire de santé), et toutes les ~15 s après un redémarrage tant que le téléphone était verrouillé. Résultat : 668 ouvertures le 29/10, et plus de 500 par jour les 21, 22, 23 et 27/10.

Décision d'Amine : retirer la réouverture.
- Le watchdog ADB, le gestionnaire de santé et le démarrage (`tier0-bootstrap.sh`) n'appellent plus la reprise.
- Les scripts `chat-continuity-restore.sh`, `chat-continuity-capture.sh` et `boot-continuity-recovery.sh` sont supprimés.
- L'indicateur de santé `chat.continuity` disparaît.

L'arrêt immédiat a été fait le 29/10 en renommant le point de reprise sur le S24 (sauvegarde conservée).
