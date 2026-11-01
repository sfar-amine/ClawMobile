# #126 (suite) : la capture du plugin recopiait OpenClaw lui-même — 1er novembre 2026

Après #498 (déployée dans e0093963), le profil du premier tour après redémarrage (S24, 01/11 18:25, `agent_main_prof126_182558`) passe encore 72,4 s sous `plugin-generation-artifact`. L'inventaire en lecture seule du dossier de capture du processus (`~/.openclaw/tmp/plugin-captures/<instance>/captures`, 467 Mo) montre ce qui est copié.

## Ce qui est encore capturé

- **Le SDK d'OpenClaw, importé par URL de fichier depuis le plugin.** Le crochet de profil de modèle (`loadInstalledSessionStoreSdk`) importait `plugin-sdk/session-store-runtime`, `plugin-sdk/config-runtime` et le chunk haché du contrat (`dist/setup-B7DuERIi.mjs`) par `file://…`. Pour OpenClaw 2026.9.6 comme 2026.10.9, un import `file:` ou absolu, depuis un module capturé et hors du plugin, est capturé avec tout son graphe de paquets. Résultat : 1 057 fichiers d'OpenClaw et 192 paquets entiers (SDK Mistral, OpenAI, Anthropic, Google, zod, typebox, hono, ajv, etc.), soit 21 045 fichiers et 190 Mo. Coût : 41,9 s de 18:26:36 à 18:27:27 (36,8 s avant #498). Le plugin exécutait en plus une seconde copie de ces modules.
- **Le dossier du plugin entier, deux fois par redémarrage.** Un plugin chargé depuis un dossier, et non depuis un fichier seul, est copié en entier, sauf `node_modules` et `.git`. L'extension contenait `fixtures` (413 fichiers), `scripts` (260), `src` (151) et `dist` (154) : 983 fichiers et 21 Mo, dont 826 inutiles à l'exécution. Coût : environ 4 s.
- **`ws`** (19 fichiers), seule dépendance déclarée depuis #498.
- Hors plugin Samantha : `@openclaw/whatsapp`, capturé trois fois (3 × 3 360 fichiers, environ 22 s). Il appartient à OpenClaw.

**Pourquoi la capture repasse à chaque redémarrage.** Elle n'a aucun cache invalidé à tort. C'est un instantané propre au processus, sous un bail SQLite, supprimé à la sortie. Rien n'y est conçu pour être réutilisé d'un redémarrage à l'autre. Réduire ce qui est copié est donc le seul levier côté plugin.

## Correction

- `importHostModule` (`openclawSdkVersions.ts`) importe un module d'OpenClaw par son spécificateur nu `openclaw/plugin-sdk/…` quand le module résout lui-même le même fichier. C'est le cas dans la Gateway, via le lien `node_modules/openclaw` vers l'hôte que crée la capture. La capture laisse alors `openclaw` à la résolution native, et le plugin partage les instances de l'hôte. Le Companion n'a pas ce lien : il garde l'URL de fichier, comme avant. Les quatre chargeurs passent par là : tour propriétaire, session store, Gateway officielle et media-store, ainsi que le mémo.
- Le contrat de profil de modèle est **lu comme texte** (`readChunkConstExport`), sans import : il faut une seule déclaration `const MODEL_PROFILE_CONTRACT_VERSION = n;`, exportée en ligne (patch 2026.9.6) ou par une clause `export { … }` sans alias (patch 2026.10.9). Sinon, la valeur est 0, qui vaut refus.
- L'extension ne reçoit plus que `dist`, `package.json` et `openclaw.plugin.json` (`lib.sh`, rsync avec `--delete-excluded`, `node_modules` et le tampon protégés). Les copies antérieures des sources sont retirées. `runtime-sync.sh` compare ce même ensemble, et une ancienne copie complète compte comme dérive.

## Gain attendu (profil après #498)

- Capture du SDK : 41,9 s, puis environ 0 s (résolution native de deux façades).
- Copie du dossier du plugin : environ 4 s, puis environ 0,6 s (156 fichiers au lieu de 983, deux fois).
- Total : environ 45 s retirées des 72,4 s capturées (−62 %), et environ 226 Mo de moins dans le dossier de capture à chaque redémarrage. Il reste environ 27 s, dont environ 22 s pour WhatsApp (OpenClaw).

## Retour arrière

Revert de ce commit, puis `companion-deploy.sh` : l'ancien `lib.sh` recopie le dossier complet.
