# Envoi typé depuis le chat Claude : pont MCP owner (04/11/2026)

**Constat S24, 04/11 à 18:25.** Un envoi WhatsApp typé depuis le chat Claude (profil `chat-owner`) a été refusé avec `read_only_policy`.

**Décision d'Amine, 04/11 à 19:05 :** aucune contrainte pour envoyer un message WhatsApp à sa demande, depuis le chat Claude, la voix Samantha ou ailleurs.

**Changement :**
- `capabilityBridge` passe `--owner-direct` à `typed-execute` uniquement pour l'exécution MCP owner : écriture permise, appelant `owner`, surface `external_mcp`.
- `claw-capability.py` transmet le drapeau aux playbooks.
- Les aperçus, les appels en lecture seule, le profil shadow, les autres appelants et les autres surfaces ne le portent jamais.

**Ordre d'activation :** d'abord samantha-ui-playbooks #397, qui accepte le drapeau, puis ce core.

**Retour arrière :** revert et redéploiement ; les appels MCP typés redeviennent en lecture seule.
