# Parallel Free W1 — adaptateur natif et gardes du transport

Le CLI OpenClaw 2026.9.6 expose une recherche `query` seulement : il ne permet pas de transporter la session technique, l’objectif et l’annulation du contrat 53. L’adaptateur `installer/termux-lite/openclaw-web-request.mjs` réutilise la factory officielle `createParallelFreeWebSearchProvider`, avec ses arguments riches et son signal, sans nouveau client MCP, service, fallback ou cache.

Ce lot n’ajoute aucune route HTTP ni capability exécutable. Il prépare le transport interne de `samantha.app.web.search` pour W2. `NO_CAPABILITY` : utilitaire engineering/interne non exposé au modèle, à l’app ou au réseau. Le registre et l’admission restent dans leurs lots canoniques ; aucune installation ni activation S24 n’est exécutée par cette PR.

## Contrat

Un objet JSON sur stdin (16 Kio maximum), un objet canonique v1 sur stdout (64 Kio maximum). Champs admis : version=1, operation=search, query publique de 1 à 1 000 caractères, sessionId UUID technique, remainingBudgetMs de 1 à 12 000, count=5, freshness=current|recent, searchQueries de 1 à 3 chaînes de 200 caractères maximum, objective de 5 000 caractères maximum. Pour une question de plus de 200 caractères, le propriétaire fournit des searchQueries minimisées ; le transport ne tronque pas une intention silencieusement.

Commande : `[node, <racine-runtime-canonique>/installer/termux-lite/openclaw-web-request.mjs]`. Aucun shell ni argument contenant la question. Aucun endpoint, header, caller, chemin de package ou provider dans le payload. La racine runtime est résolue par le propriétaire existant, jamais par la demande publique. L’environnement enfant doit être une allowlist, sans NODE_OPTIONS, NODE_PATH, credentials métier ou fournisseur payant. Le seul sélecteur de package est `CLAW_WEB_PARALLEL_PLUGIN_DIR`, fixé par l’intégrateur et non par le modèle. Il est obligatoire : l’installation réelle du plugin étant absente sur la capture, ce lot n’invente pas un chemin actif.

Le chargement du SDK réutilise `installedPackageRoot` du propriétaire existant ownerTurnGateway quand le plugin est installé hors node_modules. Un hook Node limité à ce processus et aux fichiers officiels hachés du plugin résout uniquement ses onze imports SDK vers les exports publics du host exact. Il ne rend pas le SDK accessible aux autres modules, n’écrit aucun lien et refuse de masquer un SDK local incomplet.

Le code de sortie zéro signifie fin du protocole JSON, pas succès métier. Le Graph doit interpréter `outcome`, `error` et les sources. Les issues sont complete, partial, insufficient_sources, failed et cancelled. Sources : id, titre observé, URL publique validée pour affichage, searchRetrievedAt, publishedAt connu ou null, extrait, evidenceType=search_excerpt et untrusted=true. Aucun fetch ni modèle dans W1. La validation d’URL d’affichage n’est pas une garde DNS/SSRF pour un fetch futur.

La borne globale commence avant le chargement du fournisseur et couvre ses trois phases MCP et la lecture des corps. Le même AbortSignal est transmis à toutes les phases ; l’enfant CLI ferme son processus après écriture du terminal. L’annulation distante n’est pas revendiquée. `searchMs` mesure cette frontière adaptateur complète, chargement compris ; `transportPosts` reste null faute de mesure réelle. Aucun coût n’est transformé en zéro. Le propriétaire SDK loadConfig fournit seulement les conditions d’activation (Web/plugin et allow/deny) ; ses clés et autres champs ne sont jamais transmis au provider. Le cache natif est désactivé par configuration scoped et son résolveur SDK doit confirmer TTL=0 ; aucun réglage global n’est écrit.

## Durcissement du propriétaire officiel

Le package épinglé 2026.9.6 existe ; son tarball et chaque fichier JS/JSON utilisé sont vérifiés. L’import est refusé si package absent, non patché, dérivé ou hôte différent. La plage Node du host est respectée. Le patch versionné du module MCP officiel :

- exige une seule enveloppe JSON-RPC liée à l’id de l’appel, en JSON, batch ou SSE ;
- valide le handshake et le protocole 2025-06-18 ;
- borne chaque corps décodé à 128 Kio avant JSON/SSE, même sans fetch ;
- transmet une cause HTTP sûre et Retry-After borné, sans corps d’erreur, query ou extrait brut ;
- ne crée aucun autre transport, appel ou fallback.

Le patch est une opération d’intégrateur explicite et réversible sur un fichier précisément haché. L’adaptateur de requête ne l’applique jamais. Procédure détaillée : `docs/work/samantha-runtime/runbooks/parallel-free-w1.md`.

## Fixtures et tests

Captures réellement lues sur S24 le 15/10 : reçus runtime-baseline-01, runtime-interface-03 et runtime-sdk-04 de parallel-free-audit-20261015. La fixture publique ne conserve que version, Node, configuration de recherche non secrète et présence des 11 exports SDK. Elle prouve que Parallel était absent ; elle ne prouve aucune recherche réelle.

Le vrai tarball npm public est conservé pour tests, SHA-256 `f7e4981fea7838b662548ab7c9bdb39157f41f8ee688b10ffa0702355f008a4c`. Les tests extraient cette archive, appliquent/restaurent le patch et exécutent son protocole MCP inchangé ; les exports SDK et réponses HTTP sont simulés et clairement identifiés. Ce n’est pas une qualification du SDK live. Un second test exécute le vrai SDK npm 2026.9.6, le vrai plugin hors node_modules et le patch : HTTP/DNS seulement simulés, sockets interdits, configuration isolée sans credential. Deux cas vérifient le succès natif et le refus d’un SDK local incomplet ; le resolver n’affecte pas les modules sans rapport. Le job P1 réutilise son installation SDK déjà épinglée pour cette preuve.

Les 34 tests ciblés sont inscrits au job CI `parallel-free-transport`, Node 26.11.1, exécute les contrats sans connexion fournisseur : package et drift, JSON/SSE et id étranger, plafonds, corps lent, 429/403/500, session vs transport, annulation, timeout global, injection inerte, URLs et stdin fermé. Aucune modification du paiement, Gemini, Companion ou Android.

## Retour arrière et gates

Retirer l’exposition W2 si elle a été ajoutée ultérieurement ; arrêter les runs par leur propriétaire, puis restaurer uniquement le fichier officiel connu avec le patcher --restore. Une dérive de package bloque la restauration plutôt que d’écraser un changement concurrent. L’intégrateur confirme plugin, SDK, recherche anonyme, absence de clé et santé Gateway avant activation. La publication de cette PR n’installe rien.
