# Voix Gemini Live : lecture de la clé après OpenClaw 10.9 (04/11/2026)

## Constat

Le banc voix du 04/11 a échoué dès la première question : `warm_error:token:gemini_live_token_helper_failed exit=1`.

`gemini-live-client.mjs --mint-token` cherchait la clé `GEMINI_API_KEY` en appelant l'export minifié `c` des modules `secret-store-*.mjs` d'OpenClaw. Depuis la montée 2026.10.9 du 01/11, `c` est `writeSecretStoreEntries`, une écriture et non une lecture. L'appel renvoyait une promesse rejetée et le processus sortait avec le code 1 sans message.

La voix Gemini Live ne pouvait donc plus obtenir de jeton depuis le 01/11. La clé est toujours présente : lue sur le S24 par `readSecretStoreValue`, longueur seule vérifiée.

## Ce qui change

- `resolveGeminiApiKey` n'utilise plus que la façade nommée `readSecretStoreValue({ name: "GEMINI_API_KEY" })`.
- Un module n'est importé que si sa clause d'export nomme `readSecretStoreValue`.
- Aucun export minifié n'est jamais appelé. Aucune écriture du magasin de secrets n'est possible depuis le helper.
- `GEMINI_API_KEY` dans l'environnement reste prioritaire, comme avant.

## Tests

`installer/termux-lite/test-gemini-live-client.mjs` reconstruit la disposition 10.9 relevée sur le S24 : la vraie clause d'export de la façade, plus un module avec `c` en écriture. Le test vérifie trois cas :

- la clé est lue ;
- aucune écriture ne s'exécute ;
- un dossier qui n'a que l'ancien `c` donne `gemini_api_key_unavailable`, sans appel.

Le test échoue sur l'ancien code.

## Retour arrière

Revert de ce commit puis `companion-deploy.sh <commit>`. La voix redevient indisponible sous OpenClaw 10.9. Rien n'est à restaurer sur le S24.
