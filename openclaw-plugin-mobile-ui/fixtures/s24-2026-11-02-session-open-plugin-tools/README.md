# S24 02/11/2026 — ouverture de session : chargement du plugin WhatsApp au premier tour

Captures en lecture seule sur le S24 (OpenClaw 2026.10.9, Node 24.22.2), le 02/11/2026 vers 20:10 CET, via `claw_exec`.

- `gateway-cold-runs.log` : lignes extraites de `~/.openclaw/workspace/logs/companion-openclaw-gateway.log` (rotations
  `.3` à courante, 31/10 00:38 → 02/11 20:07 UTC), codes ANSI retirés. Fenêtres : les quatre premiers tours après un
  démarrage de la Gateway ou un rechargement de configuration (31/10 23:08, 01/11 23:23, 02/11 16:15, 02/11 16:25),
  le rechargement à chaud du 02/11 16:22 et un tour de contrôle sans chargement (02/11 16:26:58). Seules les lignes de
  marqueurs sont gardées (connexion CLI, `agent`, voies, début de run, `loading whatsapp`, `loaded N plugin(s)`,
  traces `core-plugin-tool stages` / `prep stages`, battement de vie, `run_started`, début du prompt, premier
  événement modèle, `[reload]`). Aucun texte de message, aucun numéro, aucun jeton ; chemins ramenés à `~` et
  `$PREFIX`, identifiants de connexion masqués. sha256 `5a1c9ef0…3889`.
- `whatsapp-openclaw.plugin.json` : manifeste public de `@openclaw/whatsapp@2026.10.9` (`npm pack`, archive sha256
  `7ed97e83…7331`), identique à l'octet à la copie installée sur le S24 (`~/.openclaw/npm/projects/openclaw-whatsapp-…`,
  sha256 `1ffc4c4c…ff48`). `contracts.tools` = `whatsapp_call`, `whatsapp_login`.

Politique relevée le même jour dans `~/.openclaw/openclaw.json` : `agents.entries.main.tools` = `{"deny":
["skills_read","skills_search"]}`, sans `allow` ; les agents contacts ont une liste `allow` explicite.
