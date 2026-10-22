# C1 — contexte MCP sans consommation fictive entre fils

Le pont utilisait un curseur unique par client authentifié et l'avançait avant que la réponse puisse être reçue. Deux discussions indépendantes pouvaient ainsi partager une base non intégrée. Le vrai lecteur `request_context.py` permet déjà la reconstruction et les bases explicites ; il est réutilisé sans modification.

Le pont cesse de lire le curseur implicite et d'écrire un acquittement lors de l'assemblage. Les paramètres existants restent disponibles et la preuve de consommation reste explicitement non attestée. Ni droits, ni contenu source, ni autre consommateur Memory Core ne changent. Les clients historiques reconstruisent prudemment, les clients tenant leur base par fil gardent les deltas bornés. Contrat et migration d'assertion : [C6](../work/samantha-runtime/contracts/c6.md).

Vérifications ciblées : build TypeScript et préparation lite réussis ; test C6 existant vert ; nouveau test de consommateurs **14/14 contrôles verts**, sans réseau ni S24. La capture réelle existante qualifie la provenance d'accès ; les scénarios de perte et pagination sont explicitement synthétiques. La CI canonique complète attend un head publié et un numéro de PR ; ces contrôles ciblés ne la remplacent pas. Aucun modèle, effet métier, message, publication runtime ou déploiement n'a été exécuté.

Preuve avant/après locale : le même nouveau test exécuté contre le fichier `mcpBridge.ts` de `dd5078be`, compilé dans un répertoire temporaire avec les mêmes dépendances, échoue précisément sur « no cursor acknowledgement or owner write occurs ». Le candidat passe les 14 contrôles. Ce témoin de transport ne prétend pas reproduire un incident observé sur le S24.

Retour arrière : revert du lot, sans migration ou effacement de curseurs. Le contexte intégré par un fil n'est jamais supposé depuis le seul client authentifié.

Les six primitives MCP et leurs cinq rattachements sont évalués dans la note v2. Le schéma public et les droits ne changent pas. Même un marqueur imbriqué contradictoire du lecteur est remis à `advanced:false` : construire la réponse n’atteste aucune réception. Le runtime est modifié côté source, sans activation revendiquée.
