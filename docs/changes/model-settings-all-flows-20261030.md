# Réglages des modèles : interprète, recherche web et mémos vocaux — 30 octobre 2026

Décision d'Amine du 30/10 : chaque usage IA doit pouvoir se régler depuis l'app, dans Réglages → Fournisseurs et modèles. Cela vaut aussi pour l'interprète d'intentions (modèle principal et secours) et pour les modèles aujourd'hui fixés dans le code (recherche web, mémos vocaux).

## Ce qui change

- **Trois nouveaux flux réglables** : `intent_interpreter` (principal et au plus un secours), `web_search` et `voice_memos` (modèle seul). Ils passent par le chemin d'écriture existant `/agent/config`, avec la même révision de configuration (CAS), le même contrôle de coût inclus et de compte, la même confirmation biométrique si un compte s'ajoute, le même reçu v2, le rejeu, le retour arrière et « hériter ».
- **Où vit la valeur** : une clé par flux dans la configuration du plugin, dans `openclaw.json` (`interpreterModelFlow`, `webSearchModelFlow`, `voiceMemoModelFlow`).
- **Lecture et repli** : chaque exécuteur lit sa clé. Si elle est absente, mal formée ou désigne un modèle non qualifié, la constante actuelle s'applique.
- **Pas de preuve R6 pour ces trois flux** : ils ne touchent aucune conversation. Leur écriture ne crée donc pas la barrière `modelFlowSelection` des flux de conversation.
- **Modèles admis**
  - Interprète : Sol, Luna et Gemini gratuit, dans la politique LLM du plugin et avec preuve de coût inclus. Le port d'interprétation admet désormais Luna.
  - Recherche web et mémos vocaux : un seul modèle est qualifié aujourd'hui, Gemini gratuit. Le réglage existe, mais un deuxième modèle demandera sa propre qualification.
- **`/providers`**
  - Nouveau rôle `intent_interpreter` (12 rôles).
  - Ingénierie et système immunitaire affichent la chaîne des profils de `model_policy.json` : la valeur de l'agent engineering-lite n'est jamais celle utilisée, car le gouverneur passe `--model` à chaque appel.
  - Les flux en lecture seule donnent une raison précise : `memory_reindex_required`, `qualified_live_protocol`, `qualified_model_policy`.

## Restent en lecture seule

- Recherche mémoire : changer le modèle d'embeddings met la recherche vectorielle en pause jusqu'à une réindexation.
- Voix temps réel : le modèle Live est une constante de protocole qualifiée.
- Lecture à voix haute : l'app utilise la synthèse vocale du téléphone.
- Système immunitaire et ingénierie : leurs chaînes appartiennent à la politique de modèles épinglée des playbooks.
- Dictée : gérée par le téléphone.

## Ordre et retour arrière

1. Déployer ce core.
2. Activer les playbooks jumeaux (lecture du réglage de l'interprète).
3. Installer l'app jumelle.

Retour arrière : remettre chaque nouveau flux sur « hériter », puis revert de ce core et redéploiement.
