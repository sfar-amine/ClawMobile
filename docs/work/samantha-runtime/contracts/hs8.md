# HS8 — Préparation de la transcription des mémos, version 2

## Ce qui est confirmé

Le paquet OpenClaw **2026.9.6 installé sur le S24** expose les exports publics `transcribeAudioFile`, `runMediaUnderstandingFile` et `loadConfig`. Preuve nettoyée : `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-11/hs8/sdk-exports.json`, requête `mcp-codex-cloud-codex-hs8-owner-discovery-20261011-sdk-termux-package-read`, état completed, exitCode 0. La lecture porte sur les exports et déclarations du paquet installé, sans import du SDK, lecture de configuration ni appel fournisseur. Les indicateurs de qualification false dans cette fixture sont notre état de préparation, pas des mesures faites par la commande.

Sources publiques du même paquet, inspectées sans exécution : archive npm `openclaw-2026.9.6.tgz`, SHA256 `1a7355691bc0e605222ba818f1f72c1787253c78dfeb0df6be2086ec73b71e63`. Cette empreinte concerne notre source publique locale ; elle ne prétend pas être une empreinte du paquet installé sur le S24.

- `dist/plugin-sdk/media-understanding-runtime.{js,d.ts}` : exports publics.
- `dist/runtime-types-NGfGL3yx.d.ts` et `dist/runtime-CTZiSy4U.mjs` : paramètres, résultats et propriétaire du pipeline.
- `dist/plugin-sdk/config-runtime.{js,d.ts}` : `loadConfig` canonique. Le Companion standalone n'a pas d'`api.config` de plugin ; aucun lecteur de configuration ou d'identifiants maison n'est ajouté.
- `dist/runner-6mAz9T0W.mjs`, `dist/runner.entries-Dp_YV9M8.mjs`, `dist/resolve-CJ9ypW0H.mjs`, `dist/defaults.constants-Cof2g8lZ.mjs` : sélection, délais et journaux.

Contrat public exact de `transcribeAudioFile(params)` : `filePath` et `cfg` requis ; `agentId`, `agentDir`, `workspaceDir`, `mime`, `activeModel:{provider,model?}`, `language` et `prompt` facultatifs. Son type omet `timeoutMs`, `mediaUrl` et `scopeContext`. `runMediaUnderstandingFile` accepte explicitement `capability:"audio"`, les mêmes paramètres communs, `mediaUrl?`, `timeoutMs?` et `scopeContext?:{sessionKey?,channel?,chatType?}`. Tous deux utilisent le même pipeline propriétaire.

Résultat : `{text:string|undefined,provider?,model?,output?,decision?}`. Le résultat sans texte peut représenter disabled, scope-deny, skipped ou no-attachment ; un échec peut lever une erreur. Aucun de ces détails n'autorise une soumission de run ni un repli local.

## Delta utile, non branché

`memoSttBoundary.ts` est une projection pure, sans import SDK, lecture de configuration, réseau, fichier, store ni invocation de fournisseur. `projectMemoTranscript` lit uniquement la propriété propre `text` d'un résultat futur du propriétaire. Les getters et erreurs sont refusés sans message brut. Les champs `output`, `decision`, les paramètres, chemins, identifiants et détails fournisseur ne sont ni parcourus ni projetés. La validation de la forme ne prouve pas la provenance ; l'appelant futur doit être le propriétaire du résultat SDK.

La sortie conserve **exactement** le texte original accepté. Aucune troncature, réécriture, suppression de ligne ou traduction ne transforme une instruction. Texte vide, Unicode mal formé, caractères de contrôle hors CR/LF/tab, texte de plus de 12 000 unités UTF-16 ou 48 000 octets UTF-8 : refus `memo_transcript_unavailable`. Ce plafond est une borne de projection locale, pas une garantie de buffer du fournisseur.

Un filtre fermé de credentials explicites (SK, GitHub, AWS, JWT, clé privée, bearer et secrets nommés) et de codes humains nommés (OTP/PIN/CVV/CVC/code de vérification, y compris chiffres Unicode) refuse le résultat entier. Ce filtre ne prétend pas détecter tous les secrets. Aucun filtre financier ou de l'écran Fichiers n'est réutilisé : montants, numéros usuels, « paie la facture » et « recharge Orange 7 DT » restent du texte inchangé. Leur traitement futur passe par le chemin texte canonique et ses gardes existantes ; ce lot ne prend aucune décision de paiement et ne touche aucun fichier de paiement.

`MEMO_STT_QUALIFICATION` est une constante gelée refusée, pas une nouvelle autorité, configuration ou API d'admission. Aucun booléen client, probe d'exports ou fixture contractuelle ne peut l'activer. `memoSttOwnerFailure` rend une erreur générique sans accepter de détail privé.

## Bornes et blocages avant invocation

L'export installé ne prouve **pas** quel fournisseur est actif ni son autorisation. Sans entrée média explicite, le SDK peut choisir automatiquement des fournisseurs ou CLI. Aucun fournisseur/modèle n'est forcé, aucun repli payant n'est appelé et aucune configuration n'est lue ici.

Les défauts SDK audio sont 60 secondes par tentative, 20 Mio en entrée, au moins 1 024 octets et aucune limite par défaut de caractères. Une `entry.timeoutSeconds` prend priorité sur le timeout de la requête ; les tentatives peuvent se succéder. Aucun AbortSignal ni délai global public n'est attesté. Un `Promise.race` ne serait donc pas une annulation du fournisseur et n'est pas ajouté.

Le propriétaire peut écrire un résumé d'échec ; en mode verbose, des erreurs brutes et les arguments CLI peuvent comprendre le chemin du fichier. Le module pur n'écrit aucun journal, mais **ne garantit pas** la confidentialité des journaux internes du SDK. Il faut qualifier ces garanties avec Claude avant tout import/invocation produit.

Restent à confirmer dans l'issue core #126 ou la future PR : fournisseur existant autorisé et périmètre, AAC/M4A `audio/mp4` de l'app, fixture audio courte sans donnée personnelle et résultats nettoyés succès/échec, limites effectives du pipeline et absence de journaux sensibles, provenance finale du texte. L'audio devra réutiliser les pièces jointes existantes et leur rétention ; celles-ci refusent actuellement audio/mp4. Rien n'y est modifié dans cette préparation.

## Recette et retour arrière

Base : `5de1c492fe4a8f140c823848ee5bd1d884cd4c02`. Test CI `scripts/test-memo-stt-boundary.cjs` : preuve réelle d'exports distincte des fixtures contractuelles générées, formes privées/getters, Unicode et codes nommés, secrets explicites, preservation du texte et des intentions financières, bornes et projection indépendante de 50 000 champs étrangers. Budget de régression pure : 1 000 projections sous une seconde ; **aucun budget de route S24 n'est qualifié**. Compilation TypeScript et build runtime locaux.

Aucune route créée ou modifiée, aucune nouvelle capability, aucune entrée `NO_CAPABILITY`, aucune ligne de `companion-acceptance.py` inventée : le module est non branché. Aucun catalogue n'annonce `voiceMemo:true`. L'adaptateur est préparatoire, pas un lot HS8 livré ou une recette audio. Toutes les étapes CI existantes sont conservées.

État : Draft préparatoire, `merge_eligibility: blocked`, aucun déploiement. Retour arrière : retirer le module, son test CI, la fixture d'exports et les documents de cette préparation ; aucune donnée runtime à restaurer.
