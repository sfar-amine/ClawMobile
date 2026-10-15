# W3 — sélection publique Gemini isolée

Lot source du fichier53, sans activation. Base core `runtime/samantha-companion-private` au `344b2fd30d8e5293a0675fb6284f5d317f85a555`. Ne modifie ni le canal conversationnel existant, ni Companion, Android, les fournisseurs globaux ou le paiement.

## Contrat interne

`python3 <release-courante>/termux-lite/gemini-request.py --public-synthesis` reçoit uniquement stdin JSON UTF-8 (64Kio maximum), aucune interpolation shell ni question en argv. Le Harness W2 reste propriétaire de l'admission, des données publiques, des sources, de leur conservation et du run. Ce CLI interne n'est pas une nouvelle route app ni un moyen d'accorder owner ; aucune nouvelle capability dans ce dépôt. Son seul consommateur prévu est l'exécuteur de `samantha.app.web.answer` du registre playbooks.

Objet fermé : `version:1`, `query` (1–1000 caractères), `responseLanguage` (`fr|en|ar|aeb|aeb-Latn`), `sources` (1–5 objets fermés `{id,title,url,excerpt}`), `remainingBudgetMs` (entier1–12000), `correlationId` (opaque8–80 caractères alphanumériques/tiret/underscore). Le Harness projette seulement ces quatre champs des sources enrichies ; leurs dates, URL finales et identité de run restent dans le propriétaire Web. Doublons de clés JSON, secrets reconnus et dépassements sont refusés. Ce scanner est une défense supplémentaire ; il ne remplace pas la minimisation/provenance publique du Harness.

Sortie fermée v1 : `outcome:complete|partial`, modèle/profil exacts seulement si sélection réussie, `claims:[{id,text,sourceIds,support:[{sourceId,quote}]}]`, `spokenText`, `metrics:{synthesisMs,providerAttempts,reportedCostUsd}`, `error:null|{code,stage:synthesis}`. Une dégradation porte claims[] et spokenText vide ; **le parent conserve et restitue ses sources**, jamais une synthèse reconstituée. Le coût réel non rapporté reste null : ni tarifs0 du manifeste ni absence de costUsd ne prouvent la facture Google.

Le pilote est **extractif** : text doit être identique à un passage support effectivement présent dans un extrait fourni. Une paraphrase, même associée à une vraie citation, produit partial/synthesis_review_required sans nouvelle génération. Le résultat ne prouve pas la vérité du site ni l'implication d'une paraphrase : il sélectionne des citations textuelles attribuables. L'interface doit afficher explicitement ces extraits dans leur langue originale et expliquer la limite dans la langue de la demande. Aucune traduction ni réponse de synthèse libre n'est qualifiée. La voix reste sous sa gate W5 ; spokenText est seulement la concaténation déterministe des mêmes passages, bornée1200 caractères et sans URL.

## Isolation et réutilisation

Le mode appelle les gardes existantes ensure_free_policy/ensure_efficiency_policy et le profil exact `google:claw-gemini-free`, modèle `google/gemini-3.5-flash-lite`, sans fallback. Il n'appelle ni fastpath, compact_memory/build_prompt, contexte privé, session d'agent, session conversationnelle, outil, Grounding, module de Learning Gate ni écriture de statut/mémoire. Le chemin conversationnel normal et provider-fallback restent inchangés.

Le helper du même propriétaire importe uniquement les exports publics du SDK installé OpenClaw2026.9.6. `agent-runtime.resolveApiKeyForProvider` utilise profileId verrouillé et lockedProfile=true ; la clé ne quitte pas le processus fournisseur et n'est ni copiée sur disque, ni passée en argv/stdin, ni projetée. Les clés concurrentes dans l'environnement ou les overrides apiKey/headers de fournisseur font refuser le chemin. Le plugin Google livré reste l'unique fournisseur ; pas de client HTTP Gemini ajouté.

Le modèle est obtenu du **vrai manifeste Google installé**, dont le SHA-256 capturé est `8fcd5d8d460b1aa6bcdee8c15b26b0d72d11afc9e3705f604190757678aa4660`, transformé par `provider-catalog-shared.buildManifestModelProviderConfig`, puis par ModelRegistry/AuthStorage.inMemory. Cette projection locale ne lit aucun historique ni fichiermodels.json et ne change pas le catalogue global. Une autre version/signature/manifeste échoue explicitement ; il faudra requalifier ce contrat, pas inventer un endpoint/modèle.

La primitive native llm.stream reçoit un seul message utilisateur de données publiques, system immuable et tools[]. Le hook onPayload vérifie le contenu effectif puis ferme le payload : un message, aucun outil/cache/historique, JSON, réponse1800tokens maximum, requête Google avec attempts1. Les événements sont consommés localement avec borne32Kio avant parsing JSON ; ce n'est pas un nouveau flux UI. Le provider/API/baseURL sont contrôlés ; un responseModel réel divergent est refusé même si le SDK garde le modèle demandé dans son champmodel.

## Budget et annulation

Une seule échéance monotone commence avant parsing et gardes. Le reste seul est transmis au helper ; son timer/AbortSignal couvrent auth et génération. Aucune seconde tentative/génération, y compris429/503. Si le transport ne s'arrête pas à l'abort, le timeout externe termine le groupe de processus possédé (helper et lookup npm) et le récole. SIGTERM/SIGINT suivent le même arrêt ; aucun contenu tardif n'est conservé. Cela ne prétend pas annuler une génération déjà reçue par Google : l'absence de nouvelle requête et le rejet local sont garantis, pas un effet fournisseur distant inventé.

La projection d'erreur ne transporte que des codes autorisés. stderr du helper n'est pas collecté, stdout SDK est supprimé ; seul le reçu fermé est écrit. Une politique/profil inconnu ferme la sélection mais pas les sources obtenues par W2. Aucun reçu Web n'est durablement enregistré ici : cette responsabilité reste au run canonique.

## Preuves et qualification restante

Fixture réelle nettoyée : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-15/parallel-gemini-public-sdk.json`, lecture seule des exports SDK et du manifeste installé par root le15/10 ; core344b2fd, OpenClaw2026.9.6, action parallel-web-dev-20261015, étapes gemini-sdk-shape-01 / gemini-catalog-shape-03. Aucun appel Google ni credential exposé dans cette capture.

Tests inscrits en CI : Python16cas de frontière/quotes/IDs/limites et processgroup ; Node13cas de politique/canaris/egress/cancellation/sélection extractive ; intégration4cas sur **vrai SDK épinglé et vrai sérialiseur Google**, transport et credential factices, aucun réseau extérieur : payload public sans mémoire/outils,429sansretry,503sansretry, modèle réellement différent. Les20tests historiques Gemini restent requis. La portabilité runtime-sync réutilise le commit existant PR235 `f5eb36b8` ; aucune réimplémentation.

L'appel réel avec le profil S24, la facturation effective du projet et la recette texte/voix ne sont **pas** qualifiés par ces tests offline. Claude réalisera la recette contrôlée après intégration des contrats W1/W2/W4 et avant toute exposition. Cette PR n'ajoute pas de route HTTP : la recette Companion existante ne reçoit donc pas une URL artificielle dans NO_CAPABILITY.

Retour arrière source : revert des seuls commits W3 ; aucun changement de configuration, session, modèle global ou store à restaurer. Activation éventuelle exclusivement par les propriétaires de déploiement après intégration compatible. Les fichiers du helper sont embarqués avec termux-lite par le packaging Tier0 existant.
