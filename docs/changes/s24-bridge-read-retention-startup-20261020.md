# S24-fix : préparer la rétention des lectures du pont distant au démarrage

Le serveur peut appeler le propriétaire `pruneRemoteBridgeReadReceipts` après la passe de clôture F6 déjà planifiée. Le garde `CLAWMOBILE_REMOTE_BRIDGE_READ_RETENTION` doit valoir exactement `1` ; il reste désactivé par défaut jusqu'à la qualification du répertoire et de la garantie de rejeu par Claude. La politique des 50 000 lectures terminales est conservée, avec inventaire borné, budget monotone, aucune suppression sur inventaire incomplet et garde de contenu avant suppression.

Aucun nouveau timer, store ou parcours métier. Le journal existant conserve seulement les compteurs et causes fermées. Les tests comportementaux sont inscrits dans la CI propriétaire ; dans cette préparation, seule leur syntaxe et le contrat documentaire sont vérifiés. La compilation et la CI locale complète sur le SHA exact et le numéro de PR restent requises avant de qualifier la PR. Aucune action S24 ni activation.

Retour arrière : désactiver la variable puis revert de la PR pour les appels futurs. Un revert ne restaure pas les lectures terminales déjà supprimées après une activation future ; les preuves de mutation ou d'effet inconnu ne sont jamais concernées.
