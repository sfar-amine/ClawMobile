# HS8 — Adaptateur de transcription des mémos, sous qualification S24

## Ce qui est confirmé

Le paquet OpenClaw **2026.9.6 installé sur le S24** expose les exports publics `transcribeAudioFile`, `runMediaUnderstandingFile` et `loadConfig`. Preuve nettoyée : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/hs8/sdk-exports.json`, requête `mcp-codex-cloud-codex-hs8-owner-discovery-20261011-sdk-termux-package-read`, état completed, exitCode 0. La lecture porte sur les exports et déclarations du paquet installé, sans import du SDK, lecture de configuration ni appel fournisseur. Les indicateurs de qualification false dans cette fixture sont notre état de préparation, pas des mesures faites par la commande.

Sources publiques du même paquet, inspectées sans exécution : archive npm `openclaw-2026.9.6.tgz`, SHA256 `1a7355691bc0e605222ba818f1f72c1787253c78dfeb0df6be2086ec73b71e63`. Cette empreinte concerne notre source publique locale ; elle ne prétend pas être une empreinte du paquet installé sur le S24.

- `dist/plugin-sdk/media-understanding-runtime.{js,d.ts}` : exports publics.
- `dist/runtime-types-NGfGL3yx.d.ts` et `dist/runtime-CTZiSy4U.mjs` : paramètres, résultats et propriétaire du pipeline.
- `dist/plugin-sdk/config-runtime.{js,d.ts}` : `loadConfig` canonique. Le Companion standalone n'a pas d'`api.config` de plugin ; aucun lecteur de configuration ou d'identifiants maison n'est ajouté.
- `dist/runner-6mAz9T0W.mjs`, `dist/runner.entries-Dp_YV9M8.mjs`, `dist/resolve-CJ9ypW0H.mjs`, `dist/defaults.constants-Cof2g8lZ.mjs` : sélection, délais et journaux.

Contrat public exact de `transcribeAudioFile(params)` : `filePath` et `cfg` requis ; `agentId`, `agentDir`, `workspaceDir`, `mime`, `activeModel:{provider,model?}`, `language` et `prompt` facultatifs. Son type omet `timeoutMs`, `mediaUrl` et `scopeContext`. `runMediaUnderstandingFile` accepte explicitement `capability:"audio"`, les mêmes paramètres communs, `mediaUrl?`, `timeoutMs?` et `scopeContext?:{sessionKey?,channel?,chatType?}`. Tous deux utilisent le même pipeline propriétaire.

Résultat : `{text:string|undefined,provider?,model?,output?,decision?}`. Le résultat sans texte peut représenter disabled, scope-deny, skipped ou no-attachment ; un échec peut lever une erreur. Aucun de ces détails n'autorise une soumission de run ni un repli local.

## Projection de texte et admission

`memoSttBoundary.ts` est une projection pure, sans import SDK, lecture de configuration, réseau, fichier, store ni invocation de fournisseur. `projectMemoTranscript` lit uniquement la propriété propre `text` d'un résultat futur du propriétaire. Les getters et erreurs sont refusés sans message brut. Les champs `output`, `decision`, les paramètres, chemins, identifiants et détails fournisseur ne sont ni parcourus ni projetés. La validation de la forme ne prouve pas la provenance ; l'appelant futur doit être le propriétaire du résultat SDK.

La sortie conserve **exactement** le texte original accepté. Aucune troncature, réécriture, suppression de ligne ou traduction ne transforme une instruction. Texte vide, Unicode mal formé, caractères de contrôle hors CR/LF/tab, texte de plus de 12 000 unités UTF-16 ou 48 000 octets UTF-8 : refus `memo_transcript_unavailable`. Ce plafond est une borne de projection locale, pas une garantie de buffer du fournisseur.

Un filtre fermé de credentials explicites (SK, GitHub, AWS, JWT, clé privée, bearer et secrets nommés) et de codes humains nommés (OTP/PIN/CVV/CVC/code de vérification, y compris chiffres Unicode) refuse le résultat entier. Ce filtre ne prétend pas détecter tous les secrets. Aucun filtre financier ou de l'écran Fichiers n'est réutilisé : montants, numéros usuels, « paie la facture » et « recharge Orange 7 DT » restent du texte inchangé. Leur traitement futur passe par le chemin texte canonique et ses gardes existantes ; ce lot ne prend aucune décision de paiement et ne touche aucun fichier de paiement.

`MEMO_STT_QUALIFICATION` est une constante gelée refusée, pas une nouvelle autorité, configuration ou API d'admission. Aucun booléen client, probe d'exports ou fixture contractuelle ne peut l'activer. `memoSttOwnerFailure` rend une erreur générique sans accepter de détail privé.

## Bornes et blocages avant invocation

Amine a autorisé Gemini (`claw-gemini-free`) puis OpenAI le 11/10. L'export installé ne prouve pas la configuration média ou auth actuelle. L'adaptateur ci-dessous refuse une configuration incomplète et impose les deux entrées existantes ; la sélection automatique de fournisseurs ou CLI n'est pas utilisée. Le garde reste fermé avant toute configuration ou invocation produit tant que les captures S24 manquent.

Les défauts SDK audio sont 60 secondes par tentative, 20 Mio en entrée, au moins 1 024 octets et aucune limite par défaut de caractères. Une `entry.timeoutSeconds` prend priorité sur le timeout de la requête ; les tentatives peuvent se succéder. Aucun AbortSignal ni délai global public n'est attesté. Un `Promise.race` ne serait donc pas une annulation du fournisseur et n'est pas ajouté.

Le propriétaire peut écrire un résumé d'échec ; en mode verbose, des erreurs brutes et les arguments CLI peuvent comprendre le chemin du fichier. Le module pur n'écrit aucun journal, mais **ne garantit pas** la confidentialité des journaux internes du SDK. Il faut qualifier ces garanties avec Claude avant tout import/invocation produit.

Restent à confirmer dans core #138 : configuration des fournisseurs déjà autorisés et disponibilité auth, AAC/M4A `audio/mp4` de l'app, fixture audio courte sans donnée personnelle et résultats nettoyés succès/repli/échec, limites effectives du pipeline et absence de journaux sensibles, provenance finale du texte. La prise en charge M4A réutilise les pièces jointes et leur rétention, sous le même garde fermé.

## Recette et retour arrière

Base : `5de1c492fe4a8f140c823848ee5bd1d884cd4c02`. Test CI `scripts/test-memo-stt-boundary.cjs` : preuve réelle d'exports distincte des fixtures contractuelles générées, formes privées/getters, Unicode et codes nommés, secrets explicites, preservation du texte et des intentions financières, bornes et projection indépendante de 50 000 champs étrangers. Budget de régression pure : 1 000 projections sous une seconde ; **aucun budget de route S24 n'est qualifié**. Compilation TypeScript et build runtime locaux.

Aucune nouvelle route ni capability : la continuation du propriétaire existant `POST /v1/runs` est préparée sous le garde fermé, comme décrit dans [hs8-pipeline.md](hs8-pipeline.md). Aucune ligne de `companion-acceptance.py` ni capture audio n'est inventée. Le catalogue dérive `voiceMemo` du même garde et reste indisponible. L'adaptateur SDK est implémenté sous garde de qualification ; ce n'est pas une recette audio S24 réussie. Toutes les étapes CI existantes sont conservées.

État : préparation intégrable (`merge_eligibility: allowed`), avec qualification runtime refusée ; aucune transcription produit, micro ou activation S24 qualifiés. Retour arrière : retirer le module, son test CI, la fixture d'exports et les documents de cette préparation ; aucune donnée runtime à restaurer.

## Adaptateur SDK et pièces jointes

La décision fournisseur est acquise ; les captures et la qualification du runtime restent nécessaires pour ouvrir le garde existant.

`memoSttOwner.ts` raccorde les exports publics `loadConfig` et `runMediaUnderstandingFile` du SDK. Le loader ne devine aucun chemin d'installation : résolution des seuls exports publics depuis le processus Companion, import ESM natif conservé dans le build CommonJS. Sa résolution installée reste à confirmer par Claude.

La projection de configuration, limitée à la requête et jamais persistée, réutilise les modèles audio existants de `tools.media.models`, choisit Google puis OpenAI, épingle le profil existant `google:claw-gemini-free` seulement si `loadConfig` atteste sa présence dans les profils Google, conserve leurs modèles/configuration d'auth et exclut les CLI et autres fournisseurs. Aucun modèle ni compte n'est créé. L'entrée OpenAI épingle également un profil OAuth/token existant de `loadConfig` : son `profile` média explicitement configuré, sinon l'unique profil de souscription configuré. Une absence, une ambiguïté ou un profil API-key sont refusés ; aucune découverte de clé d'environnement ou de compte facturé. L'identifiant privé est conservé seulement dans la config SDK, jamais projeté ni journalisé. Une configuration absente, incomplète ou explicitement désactivée est refusée. `preferredModel` est remis sur l'entrée Google existante pour préserver cet ordre. Entrées et config média conservent leurs limites les plus petites, plafonnées à 10 Mio et 60 secondes par tentative. Le `maxChars` SDK est retiré de la projection de requête : le SDK tronque silencieusement le texte, ce qui pourrait modifier une instruction. La projection finale refuse le résultat entier au-delà de 12 000 caractères ; elle ne tronque pas. Le buffer de sortie fournisseur et le délai global avec retries restent à qualifier.

L'adaptateur n'accepte qu'un identifiant de pièce jointe du propriétaire existant, jamais un chemin, une configuration ou un fournisseur du client. La lecture du fichier réutilise `attachmentContent`, et le descripteur est fermé après le propriétaire. Le MIME prévu est AAC/M4A `audio/mp4`, extension `.m4a`, avec les mêmes quota et rétention. Le contrôle `ftyp` / marque M4A vérifie seulement le conteneur ; il ne revendique aucune preuve du codec ni de transcription.

**Aucun chemin produit activé** : le garde existant `MEMO_STT_QUALIFICATION` reste refusé avant import SDK, lecture config ou fichier. Les uploads audio sont également refusés par ce garde ; `inputs.voiceMemo` reste indisponible. L'adaptateur n'ajoute aucune route ni capability. La continuation idempotente dans le propriétaire des runs est préparée : après qualification réelle, elle passe le texte intact au chemin de demande canonique existant, sous la même identité et sans la pièce jointe audio.

Pièces exactes demandées à Claude dans core #138 : audio neutre réellement enregistré sur S24 et provenance (AAC/M4A, `audio/mp4`, durée, taille, SHA256), projection nettoyée des entrées/config audio et disponibilité auth booléenne, résultats SDK succès Google/repli OpenAI/double échec, budgets par tentative et total avec retries, absence de CLI/autres fournisseurs et journaux privés. Aucun identifiant/secret ni erreur brute. Les modèles publics par défaut ne sont pas une preuve des modèles S24. Les contrats hors ligne de l'adaptateur sont déclarés synthétiques.

### Sélection de compte et intégrité du texte

La source publique SDK 2026.9.6 confirme le chemin OpenAI `transcribeAudioWithContext` : une entrée `profile` explicite utilise `lockedProfile:true`, sans imposer l'API-key STT ; OAuth/token existants sont acceptés sur l'endpoint officiel sans overrides de requête/headers. La compatibilité réelle du compte reste une qualification technique S24, pas une nouvelle décision fournisseur.

Pour Google, le profil attendu doit être déclaré `api_key`. Le SDK donne priorité à une clé dans `models.providers.google.apiKey` et sa rotation peut découvrir des clés d'environnement. L'adaptateur exclut Google et utilise seulement le repli OpenAI configuré en présence de ces surfaces alternatives (présence seulement, aucune valeur lue, copiée, affichée ou modifiée), plutôt que de promettre un verrou de compte que la seule entrée `profile` ne garantirait pas. Les chemins endpoint/proxy existants restent dans la config ; la capture doit attester qu'ils préservent le compte gratuit et n'ajoutent aucune source auth privée. Le refus d'une configuration technique incompatible ne remet pas en attente la décision d'Amine.

Un prompt de transcription verbatim dans la langue d'origine est fixé au paramètre public `prompt`, qui prend priorité sur les prompts d'entries/config. Aucun résumé, traduction, réponse ou exécution de consignes contenues dans l'audio n'est demandé. La justesse de la transcription nécessite toujours la recette réelle.

Le SDK relit un pathname : conserver le descripteur du propriétaire ouvert ne prouve pas l'absence de substitution/rétention concurrente entre cette admission et la lecture SDK. Cette frontière de fichiers et le budget total doivent être qualifiés avant activation ; aucun AbortSignal global public ne permet ici de promettre l'arrêt du fournisseur.

Le SDK expose aussi `resolveApiKeyForProvider` dans `openclaw/plugin-sdk/agent-runtime` (signature publique avec `lockedProfile`). L'adaptateur lui demande la disponibilité du profil gratuit avec `lockedProfile:true` avant média, puis vérifie uniquement les métadonnées `profileId` et `mode` ; aucune clé retournée n'est copiée, affichée ou réinjectée. Si cette prévalidation échoue ou renvoie un autre profil, la requête au même propriétaire média ne contient que l'entrée OpenAI déjà configurée. Il ne découvre jamais un autre Google. Le SDK doit également confirmer sur le S24 la disponibilité de cet export et la conformité de son chemin effectif, notamment en cas de changement de credentials entre prévalidation et média ; le garde d'activation reste fermé.

Les trois couches d’en-têtes SDK (provider, audio, entrée) sont inspectées par noms uniquement. Un en-tête d’auth alternatif Google écarte le primaire ; un en-tête d’auth partagé ou OpenAI refuse la demande, sans exécution. Les en-têtes de transport ordinaires restent intacts, ainsi que les endpoints/proxies existants. La recherche provider suit la normalisation SDK (première clé trim/lowercase) ; casing et espaces ne contournent pas le contrôle de présence de `apiKey`. Les limites sont le minimum des plafonds locaux et des limites entry/audio, jamais la valeur entry prioritaire plus permissive.


## Capture du 11/10 et correction de résolution du SDK public

Capture Claude #170, commit `a75955f8bc21f84984a1df9c10f1afaf2d8ad87a`, commentaire [6108368633](https://github.com/sfar-amine/samantha-core/pull/138#issuecomment-6108368633), runtime capturé `363a6b8e`, OpenClaw `2026.9.6 (eb377ac)` : `fixtures/s24-2026-10-11/hs8/media-config-and-sdk-resolution.json`, SHA256 `8285b97c703eb941fcfe1c3b2136fcd208b46411c565778c141b1f470e7ac780`. La capture confirme un tableau `tools.media.models` **vide**, le profil gratuit Google disponible et OpenAI OAuth disponible ; aucun appel audio n'a été effectué. Les exports existent dans le paquet global mais leur résolution depuis le Companion donne `MODULE_NOT_FOUND`.

La résolution conserve d'abord le paquet local. En son absence seulement, `execFile("npm", ["root", "-g"])` consulte l'installation existante, sans shell, installation ni modification de PATH/NODE_PATH. Limites : 3 secondes et 4 Kio de sortie ; une racine absolue unique est exigée. `createRequire` ancré sur le `package.json` du paquet global résout les **exports publics**, sans chemin interne de secours. Le nom/version du paquet est contrôlé (`openclaw`, `2026.9.6`, seules signatures ici attestées), les trois entrées doivent appartenir au même paquet réel et être des fichiers. Un paquet local présent mais incompatible/incomplet n'est pas contourné par un autre paquet. L'import reste ESM via `pathToFileURL`. Les échecs sont génériques ; aucune configuration privée n'est lue par cette résolution.

`test-memo-sdk-resolution.cjs`, inscrit dans la CI existante, prépare les cas local/global ESM, racine absente/invalide, version différente, export absent, paquet local partiel, sortie npm excessive et vrai timeout du processus npm synthétique. Les paquets de test sont synthétiques ; ils ne prétendent pas prouver l'import ni l'auth du S24. Tests de ce correctif **non exécutés** à ce stade : attente du créneau CI exclusif, puis suite complète sur la nouvelle tête.

### Proposition de configuration audio à appliquer par Claude

La capture atteste l'absence de modèles ; les noms ci-dessous sont des **choix techniques proposés depuis les défauts du SDK public 2026.9.6**, pas des faits S24 ni une qualification audio : Google `gemini-3-flash-preview` (`dist/extensions/google/openclaw.plugin.json`, `mediaUnderstandingProviderMetadata.google.defaultModels.audio`) puis OpenAI `gpt-4o-transcribe` (`dist/default-models-DOFL1mMC.mjs`, défaut audio réutilisé par `dist/media-understanding-provider-CXO0EvwX.mjs`). Le patch suivant complète uniquement les entrées audio dans la config propriétaire existante ; Claude préserve les autres champs déjà installés.

```json
{"tools":{"media":{"models":[
  {"type":"provider","provider":"google","model":"gemini-3-flash-preview","profile":"google:claw-gemini-free","capabilities":["audio"],"maxBytes":10485760,"timeoutSeconds":60},
  {"type":"provider","provider":"openai","model":"gpt-4o-transcribe","capabilities":["audio"],"maxBytes":10485760,"timeoutSeconds":60}
]}}}
```

L'entrée OpenAI réutilise l'unique profil OAuth/token existant attesté par `loadConfig` ; s'il y en a plusieurs, Claude épingle dans la config locale le profil de souscription existant retenu, sans publier son identifiant privé. Aucun compte, API-key, endpoint, rotation ou auth alternative n'est ajouté. Le primaire reste verrouillé sur `google:claw-gemini-free` et le repli OpenAI sur son profil configuré ; les refus d'overrides d'auth et limites minimales existants restent actifs. Ces plafonds de préparation ne constituent pas un budget global qualifié : délais cumulés, retries et arrêt effectif restent à mesurer.

Claude doit encore attester l'import dans le processus Companion, capturer les seules métadonnées de config après application, puis réaliser avec Amine l'audio neutre et les cas succès Google/repli OpenAI/double échec, délais, rétention et journaux. **Le micro, l'admission et le catalogue restent fermés** jusqu'à ces preuves. Codex ne modifie pas la configuration S24 et n'active rien.
