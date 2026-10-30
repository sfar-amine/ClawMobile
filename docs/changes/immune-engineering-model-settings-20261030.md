# Réglages des modèles : système immunitaire et apprentissage d'ingénierie — 30 octobre 2026

Décision d'Amine du 30/10 : les modèles du système immunitaire et de l'apprentissage d'ingénierie se règlent depuis l'app (Réglages → Fournisseurs et modèles), exactement comme l'interprète d'intentions.

## Ce qui change

- **Deux nouveaux flux réglables** : `immune_system` et `engineering_learning`, avec un modèle principal et au plus un secours. Ils passent par le chemin d'écriture existant `/agent/config` : même révision de configuration (CAS), même contrôle de coût inclus et de compte, confirmation biométrique si un compte s'ajoute, reçu v2, rejeu, retour arrière et « hériter ».
- **Où vit la valeur** : une clé par flux dans la configuration du plugin (`immuneModelFlow`, `engineeringModelFlow`), schéma du plugin étendu (`additionalProperties: false` conservé).
- **Pas de preuve R6** (`modelFlowSelection`) : comme pour l'interprète, ces flux ne touchent aucune conversation.
- **Modèles admis** : les créneaux qualifiés (exécuteur natif, `qualification_ref`) du profil du gouverneur dans `model_policy.json` (`IMMUNE_ENGINEERING`, `ENGINEERING`) **et** la politique LLM du plugin, avec preuve de coût inclus. Aujourd'hui : Sol, Luna et Gemini gratuit pour les deux flux. Claude (exécuteur CLI du profil `ENGINEERING`) n'est jamais un choix de l'app. Sans politique lisible, aucun choix n'est proposé et aucune écriture n'a lieu.
- **Chaîne effective** : le réglage passe en tête, puis le reste du profil dans l'ordre de la politique, pour que le système immunitaire ne reste jamais sans modèle. Réglage absent, mal formé ou non qualifié : chaîne du profil inchangée.
- **`/providers`** : les deux rôles deviennent modifiables et montrent la chaîne effective (source `gateway_config` si le réglage est valide, sinon `model_policy`, avec `model_flow_setting_ignored` si une valeur stockée est ignorée).
- **`/agent/config`** : pour ces deux flux, `policyProfile` et `policyContinuation` (le reste du profil qui suit les modèles choisis). « Hériter » affiche le premier modèle admis du profil et le suivant.

## Ordre et retour arrière

1. Déployer ce core.
2. Activer les playbooks jumeaux (lecture du réglage par le gouverneur).
3. Installer l'app jumelle.

Retour arrière : remettre les deux flux sur « hériter » depuis l'app (aucune clé `immuneModelFlow` ni `engineeringModelFlow` ne doit rester dans `openclaw.json`), puis revert de ce core et redéploiement. L'ancien schéma du plugin refuse les clés supplémentaires.
