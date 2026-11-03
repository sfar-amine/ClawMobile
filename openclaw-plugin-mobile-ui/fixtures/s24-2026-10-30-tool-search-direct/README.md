# Tool Search et outils typés — capture S24 du 30/10

`brain-run-tool-sequence.json` : appels d'outils du run cerveau « Quel est l'état de mes factures » (noms et arguments seulement, aucun résultat), avec l'erreur `tool_search` du journal Gateway.

`local-model-lean-CHSAjCEl.mjs.gz` : module public du SDK 2026.9.6, identique octet pour octet au fichier du S24 (`provenance.json`). Le test exécute ses fonctions exactes (`readToolSearchRequest`, `applyToolSearchCatalog`, `applyToolCatalogCompaction`) avec des dépendances inertes : aucun modèle, réseau, secret ni appareil.
