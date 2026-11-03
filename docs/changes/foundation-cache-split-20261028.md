# Le contexte de base ne casse plus le cache du modèle — 28 octobre 2026

Mesures du 28/10 sur le S24, après l'activation de L2 : sur un tour WhatsApp, le modèle a relu sans cache 61 500 des 122 000 tokens envoyés, puis 60 600 sur le tour suivant, 52 s plus tard. Avant L2, il en relisait entre 300 et 11 000. Le temps de décision est passé de 2–4 s à 6–12 s.

Cause : le cache des fournisseurs ne réutilise qu'un début de prompt identique. Le hook plaçait tout le contexte de base au tout début du prompt système, vue mémoire comprise. Or la vue mémoire change à chaque événement mémoire, donc chaque changement obligeait à relire presque tout le prompt.

Nouveau placement (producteur playbooks `--layout split`) :
- **règles stables** (consignes, liste des skills, règles essentielles) : dans le prompt système, comme avant ;
- **vue mémoire** : avec le message courant, après l'historique (`prependContext` d'OpenClaw, non enregistré dans l'historique). Un changement de mémoire ne fait relire que ce message ;
- **WhatsApp et tours propriétaire interactifs** : SOUL.md et les sections d'AGENTS.md ne sont plus répétés, car OpenClaw les injecte déjà en entier dans le Project Context. Les tours cron, sous-agent et heartbeat gardent le texte complet ;
- **app (Companion)** : l'extraSystemPrompt garde la partie stable complète, car le démarrage léger n'a pas SOUL.md. La vue mémoire arrive par le hook.

Si le producteur actif est plus ancien, l'ancien bloc unique est utilisé tel quel.

Test : `test-owner-foundation.cjs` vérifie qu'un changement de mémoire laisse le prompt système identique à l'octet près, la répartition par surface et les plafonds ; il échoue sur l'ancien code. Retour arrière : revert puis redéploiement.
