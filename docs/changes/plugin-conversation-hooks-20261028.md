# Hooks de conversation du plugin Samantha débloqués — 28 octobre 2026

Depuis OpenClaw 2026.9.6, un plugin non intégré ne reçoit ses hooks de conversation que si sa configuration l'autorise (`hooks.allowConversationAccess=true`). Le plugin Samantha n'avait pas cette autorisation : à chaque démarrage, le Gateway bloquait `agent_end`, `before_prompt_build`, `before_model_resolve` et `before_agent_run`.

Effets constatés sur le S24 le 28/10 :
- la fin d'un tour WhatsApp n'arrivait jamais au Companion (10 tours sur 10 restés « en cours ») ; après 30 s, il envoyait donc « Je reviens vers toi. », alors que la réponse était déjà partie ;
- le socle propriétaire (L2) n'était pas injecté dans les tours du Gateway, et le modèle choisi par conversation n'était pas appliqué.

L'installateur (`clawmobile_enable_plugin` et la mise à jour en place) pose désormais cette autorisation. Le Companion l'applique à son démarrage ; le Gateway la lit à son redémarrage.

Test : `test-plugin-install-noninteractive.sh` vérifie l'autorisation sur les deux chemins ; il échoue sur l'ancien `lib.sh`. Retour arrière : revert, puis `openclaw config unset` de la clé et redémarrage du Gateway.
