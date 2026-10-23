# Chantier 1 : interprète chargé dans le Gateway (doc 71, étape 1)

- Nouvelle méthode Gateway `samantha.intent.interpret`, enregistrée par le plugin Samantha : un seul interprète pour toutes les surfaces, appelé via `api.runtime.llm.complete` dans le Gateway déjà chargé. Aucun processus ni session d'agent par tour.
- Gemini `gemini-3.5-flash-lite` (profil gratuit) d'abord ; Luna `gpt-5.6-luna` uniquement après une panne technique de Gemini (délai, échec, indisponibilité, sortie rejetée ou illisible), avec `requiredAuthMode: "oauth"`. Un refus d'autorisation ou une annulation n'atteint jamais Luna.
- Sortie : décision structurée (`intent`, `ambiguous`, `no_intent`) ou code stable, avec chaque tentative et sa durée.
- Politique de modèles du plugin dans `docs/runtime/config/samantha-intent-interpreter.json`, limitée aux deux modèles, appliquée par le propriétaire de configuration OpenClaw existant.
- Aucun appelant n'est encore branché : l'entrée unique des surfaces est l'étape suivante.
