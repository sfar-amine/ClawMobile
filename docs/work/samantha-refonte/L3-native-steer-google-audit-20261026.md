# L3 — admission native, continuité du cerveau et schémas Gemini

26 octobre 2026. Sources publiques installées lues sur le S24, sans configuration, identifiant d’accès ni appel modèle. Ces lectures ne sont pas une recette du comportement d’un modèle. Les reçus privés `l3-sdk-*-receipt.json` sont conservés sous `/workspace/refonte-evidence`, action stable `l3-sdk-queue-20261026`. Les fixtures versionnent uniquement les fonctions utiles et les empreintes des fichiers complets.

## Entrée ultérieure dans le même cerveau

Le propriétaire natif `resolveQueueSettingsCore`, dans `settings-5LUPsyZF.mjs` (SHA256 `5888d8a0ae6c60524072d096af6db9292a2a0a932eb60ef1fd9b5e80381fb002`), choisit l’option inline, puis la session, puis le canal/global, et enfin `steer`. Ce défaut ne prouve pas le réglage effectif de la session owner en production.

La branche `runActiveReplySteer` de `agent-runner.runtime-DH-TOu7I.mjs` (SHA256 `f3e2b410e2089ac1c8834df5ef2ba7813cbbf2c5f36844861b1d8d8c446f2644`) ne passe pas par l’attente de fin du run. Elle prend une cible d’injection de l’opération exacte, gare le candidat dans la file native existante, conserve l’ordre des prédécesseurs, puis appelle `beginReplyMessageInjectionTarget` avec la preuve propriétaire courante et le fingerprint des outils.

Le propriétaire `reply-run-registry.registry-BoHW1D6q.mjs` (SHA256 `a88885150041cb420cc3d6677e26999c7342deef2c2e4ce862946a0ed5d34ef6`) refuse une opération remplacée, finie, périmée ou dont le backend a changé. Pour une nouvelle entrée utilisateur, le fingerprint d’autorité doit correspondre au run actif. Sa capacité `messageInjectionV2` est révocable ; elle n’est pas reconstruite depuis un argument JSON. L’adoption attend la confirmation de persistance du transcript sur le `targetRunId` exact. Une autorité différente ou une finalisation fermée garde le repli `followup` ; ce refus ne devient pas un succès de Stop.

Le backend `builtin-openclaw-q1hiFm14.mjs` (SHA256 `e4504516aef56cd293e11369e420148c5ad60c80e60128ed64bfb57fb7239e25`) vérifie encore l’enregistrement actif avant `activeSession.steer`. Le propriétaire de session `resource-loader-v8341X6T.mjs` (SHA256 `6c560f0d721601c1fe84f297f26f23e82e0bc6d29c5da05126a75b2b92719083`) prépare une vraie entrée utilisateur, en garde l’identité de file et appelle `agent.steer`. Il documente sa consommation avant le prochain outil non démarré ou appel modèle. Les outils déjà lancés continuent.

L’AgentLoop installé `agent-core-DG5aPUnb.mjs` (SHA256 `96221c65ea8e15d6499ca9f817e5d7629151b42c6d9742000791f2f48f2cebcd`) draine `getSteeringMessages`, ajoute ces entrées au contexte conservé, puis sollicite le modèle avant `agent_end`. Le test exécute cette fonction exacte avec une frontière provider factice : une entrée ultérieure arrive pendant le premier appel, le second appel du même loop reçoit le contexte initial et la nouvelle entrée, et leur commit précède l’unique `agent_end`. Il n’ajoute aucun interprète ou pré-routeur.

Conséquence pour Stop : si l’entrée est adoptée par ce même cerveau, celui-ci peut choisir de cesser ses nouveaux appels et de terminer naturellement son tour. Il conserve l’UUID du run exécutant ; l’interdiction de `chat.abort` sur son propre run reste intacte. L’outil d’abort exact sert uniquement à un autre run admis et positivement actif. Le mode SDK `interrupt`, qui annule avant choix IA, n’est pas sélectionné. Les annulations techniques natives en cas de persistance/adoption incertaine restent des gardes existantes, sans prétendre constituer la décision métier du cerveau.

## Limite d’observation pour L4

Une entrée reçue puis adoptée par `steer` a son UUID d’ingress, mais le cerveau continue sous l’UUID adoptant. L’entrée n’est donc pas la preuve d’un nouveau run exécutant distinct, ni la promesse de son propre `agent_end`. Les observations L3 ne donnent toujours aucun droit d’abort : le contexte SDK courant, la session owner exacte et une lecture positive des `activeRunIds` restent exigés. Aucun mapping par dernier run, texte ou récence n’est admis.

Le SDK possède en interne `targetRunId`, l’acceptation et `transcriptCommit`, ainsi que `confirmSteerTargetRunIdForPersistence`. Aucun callback plugin public portant positivement les deux UUIDs n’a encore été qualifié par cet audit. L4 doit qualifier ce raccord chez le propriétaire existant avant de compter les mesures et budgets de plusieurs ingress comme des runs indépendants. Aucun nouveau store ou patch SDK natif n’est livré dans L3 à ce titre.

## Schémas Google

Le package installé est `@openclaw/ai`. Sa fonction `convertGoogleTools`, dans `google-messages-DB7GKkDk.mjs` (SHA256 `9d043610723f4c9c6a87ce13ea096ca39ebc74922819b0ab658ff69aa512f19c`), transmet directement `tool.parameters` dans `parametersJsonSchema`. `buildGoogleGenerateContentParams`, dans `google-shared-Bok4I6zB.mjs` (SHA256 `d3ff8552e78bd86c8df3d983d997e8a3791b633451211e52337a03eed072630f`), utilise cette conversion dans le payload generate-content.

Le SDK `@google/genai/dist/node/index.mjs` installé (SHA256 `05c68ed403695c904167d53613a10852e18df9b9eb6cd671c889d34c318996d0`) distingue `parameters` du champ `parametersJsonSchema`. Sa fonction `tTool` ne passe pas ce dernier dans le convertisseur de l’ancien objet Google Schema. Le mapper MCP installé choisit également `parametersJsonSchema` depuis `inputSchema`.

Le test applique ces fonctions capturées à tous les descripteurs produits par `createTypedCapabilityTools` depuis la projection canonique épinglée. Il vérifie l’égalité des schémas, les objets fermés, `anyOf`, un `oneOf` auteur et l’absence de mutation ; le convertisseur legacy est remplacé par un refus pour vérifier qu’il n’est jamais sollicité. Le backend conserve toute sa validation stricte et ses tests adverses existants. Cette preuve couvre ce transport Google generate-content ; elle ne prouve ni quota/coût ni résultat métier. Le fournisseur réellement retenu par le main en recette doit être confirmé avant d’attribuer cette preuve à un autre transport, tel qu’un backend CLI.

## Portes avant clôture

Les deux nouveaux tests sont inscrits dans la CI de la même PR. La CI canonique finale et l’appariement Core/playbooks restent obligatoires. La recette réelle doit attester le mode effectif, le nouveau message consommé par le cerveau avant `agent_end`, sa décision et sa fin, le maintien des effets déjà envoyés et la conservation des reçus incertains sans rejeu. Une preuve de source, un ACK d’adoption ou un test factice ne remplace aucune de ces étapes.
