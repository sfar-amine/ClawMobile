# Réponse web rédigée et sourcée — synthèse Gemini réparée (17/10/2026)

## Constat sur le S24
Retour d'Amine (17/10, 16:01) : « est-ce que thibo depen ai fera un reset aujourd'hui ? » via la tuile « Search the web » ne renvoie que les 5 sources. Lecture du run `run_1792249272899_4c533f37` et sondes de la release Tier0 `20261017T135303-d3beb769` (fixture `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-17/web-answer-synthesis.json`) :

1. Routage (corrigé côté playbooks, même lot) : la tuile nue choisissait `samantha.app.web.search`, en anglais.
2. Même routée vers `answer`, la synthèse n'aboutissait jamais sur le S24 :
   - `sdk_unavailable` : sur le Node Termux (v24.21.0), `promisify(execFile)` rend la sortie brute (chaîne), donc `(…).stdout.trim()` levait une exception avant tout chargement du SDK ;
   - `profile_unavailable` : la config porte `models.providers.google.apiKey` sous forme de SecretRef (`store`/`default`/`GEMINI_API_KEY`), refusée par la politique alors qu'elle n'est jamais lue (registre construit avec `models.providers={}`, clé issue du profil verrouillé) ;
   - `invalid_provider_response` : le SDK transmet `httpOptions.timeout` comme délai serveur ; avec ~6 s restantes Google répond HTTP 400 « Manually set deadline 6s is too short. Minimum allowed deadline is 10s. » ;
   - contrat extractif : même réussie, la « synthèse » ne recopiait que des citations anglaises.

## Changements (core)
- `gemini-public-synthesis.mjs` : racine npm globale par la forme callback d'`execFile` (même sens sur tous les Node) ; SecretRef fournisseur ignorée, en-têtes fournisseur toujours refusés, `auth.source` doit être le profil verrouillé ; délai serveur au moins 10 s (la borne réelle reste l'abort local) ; JSON entouré d'un bloc ``` ou rendu en liste nue toléré (même contenu, mêmes contrôles) ; chaque phrase doit citer au moins une source, y compris pour dire que les extraits ne couvrent pas la question ; réponse rédigée dans la langue de la question, une phrase par claim, avec la date du jour et les dates de publication ; claims non ancrés écartés un par un (échec seulement si aucun ne reste).
- `gemini-request.py` : `publishedAt` facultatif par source ; claim rédigé admis si chaque source citée a une citation exacte et si chaque chiffre et nom propre figure dans ses citations, titres, dates, la question ou la date du jour ; marqueur `[sN]` dans le texte refusé.
- `runWeb.ts` : la projection n'exige plus `quote === text` (chaque preuve reste une citation exacte de l'extrait) ; sans claim admis, le texte du run donne d'abord la cause puis la liste des sources.
- L'app (`RuntimeUi.kt`) affiche déjà chaque claim avec `[s1, s2]` puis les sources : aucun changement d'APK.

## Routes et budget
Aucune route nouvelle. Budget public total porté de 12 à 20 s (`PUBLIC_WEB_BUDGET_MS`, `runWeb.ts`, repris par `capabilityTool`, `capabilityBridge`, `dialogueSurface`, `modelFastPath`, `remoteBridge`, `mcpBridge`, `model-fast-path.py`, `claw-capability.py`, `gemini-request.py` et `skill_intelligence/public_web.py` côté playbooks) ; l'étape de recherche garde sa borne de 12 s (`openclaw-web-request.mjs` inchangé). Sonde S24 du 17/10 : recherche 4,3–6,8 s puis synthèse 5,9 s, soit 10,5–12,1 s : à 12 s la synthèse était systématiquement coupée (`deadline_exceeded`).

## Tests (inscrits en CI, job O8 et P1)
`test-gemini-public-synthesis.py` (20), `test-gemini-public-synthesis.mjs` (18, dont fixture S24), `test-gemini-request.py`, `scripts/test-run-web*.cjs`, `test-gemini-public-native.mjs` (SDK réel épinglé).

## Retour arrière
Revert du merge puis avance rapide/redémarrage habituels ; la politique extractive revient avec le commit précédent.
