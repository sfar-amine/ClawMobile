# Envoi typé depuis le chat Claude : pont MCP owner (04/11/2026)

**Constat S24, 04/11 à 18:25.** Un envoi WhatsApp typé depuis le chat Claude (profil `chat-owner`) a été refusé avec `read_only_policy`.

**Décision d'Amine, 04/11 à 19:05 :** aucune contrainte pour envoyer un message WhatsApp à sa demande, depuis le chat Claude, la voix Samantha ou ailleurs.

**Changement :**
- `capabilityBridge` passe `--owner-direct` à `typed-execute` uniquement pour l'exécution MCP owner : écriture permise, appelant `owner`, surface `external_mcp`.
- `claw-capability.py` transmet le drapeau aux playbooks.
- Les aperçus, les appels en lecture seule, le profil shadow, les autres appelants et les autres surfaces ne le portent jamais.

**Ordre d'activation :** d'abord samantha-ui-playbooks #397, qui accepte le drapeau, puis ce core.

**Retour arrière :** revert et redéploiement ; les appels MCP typés redeviennent en lecture seule.

**Ajout (recherche web) :** l'indication de `samantha_web` demande désormais une requête de quelques mots-clés, 200 caractères au plus. Le 04/11 à 19:15, une requête de 230 caractères a été refusée par le schéma avant la recherche.

**Ajout (budget web) :** le budget de la recherche web passe de 30 à 40 s, sur décision d'Amine. Le 04/11 à 19:15, une recherche d'actualité a dépassé 30 s.
- La valeur est changée partout où elle est définie : `runWeb.ts`, `model-fast-path.py`, `claw-capability.py`, `gemini-request.py` et `codex-web-request.mjs`.
- Le plafond du helper typé web passe de 45 à 50 s.
- La parité avec les playbooks (#397) est contrôlée au déploiement : il faut épingler les playbooks d'abord.
