# Recherche web Codex sur le S24

## Pourquoi

Depuis le passage à `tools.web.search.provider=codex` (03/11, 12 h 09), toutes les recherches web de Sol échouent sur le
S24. La vérification en direct de 19 h 14 donnait : « La recherche web a échoué côté fournisseur ».

Quatre causes ont été trouvées l'une après l'autre sur le téléphone :

1. **Dossier temporaire refusé (propriétaire).** `fs-safe` refuse tout dossier temporaire, parce que `/data`
   appartient à l'uid système d'Android 1000 et non à root.
2. **Dossier temporaire refusé (droits).** `/data`, `/data/data` puis `/data/data/com.termux/files` sont en `0771`,
   donc inscriptibles par leur groupe, sans bit sticky.
3. **Délai trop court.** Le tour Codex borné limite `model/list` à 5 s, alors que l'app-server du téléphone met plus
   longtemps une fois authentifié auprès de ChatGPT.
4. **Pas de DNS.** Le binaire Codex est compilé en musl statique et ne lit que `/etc/resolv.conf`, absent sur Android.
   Le tour s'arrête alors sur `Reconnecting... workspace routing discovery failed`.

## Ce qui change

**Nouveau jeu épinglé `codex-android-compat`**, appliqué par le propriétaire existant (`whatsapp-network-recovery.py`).
Ce propriétaire sait maintenant trouver le paquet du plugin `@openclaw/codex`, comme il le fait déjà pour WhatsApp.

| Racine | Module | Changement |
|---|---|---|
| openclaw | `node_modules/@openclaw/fs-safe/dist/temp-workspace-ownership.js` | sous Android seulement, le propriétaire système (uid 1000) est traité comme root |
| openclaw | `node_modules/@openclaw/fs-safe/dist/temp-workspace-child-admission.js` | sous Android seulement, l'écriture de groupe est admise sur les ancêtres non privés possédés par le système ou par l'app (groupe propre à l'app) ; le dossier final reste strictement privé |
| codex | `dist/.setup/bounded-turn-B91suzbV.mjs` | `model/list` : 5 s → 20 s, dans la même échéance globale |
| codex | `dist/.setup/web-search-provider.runtime-DEBVJch2.mjs` | `OPENCLAW_CODEX_WEB_SEARCH_MODEL` choisit le modèle et `OPENCLAW_CODEX_WEB_SEARCH_TIMEOUT_S` peut fixer le délai ; sans ces variables, le comportement d'origine est inchangé |

**Nouveau lanceur `codex-termux.sh`.** Il lance le binaire Codex géré par le plugin sous `proot`, avec le
`resolv.conf` de Termux monté sur `/etc/resolv.conf` et `SSL_CERT_FILE` pointant vers les certificats de Termux.

**Câblage de `gateway-start.sh`.** Il applique le jeu, puis exporte `OPENCLAW_CODEX_APP_SERVER_BIN` (le lanceur) et
`OPENCLAW_CODEX_WEB_SEARCH_MODEL=gpt-5.6-luna` seulement après une vérification `--check` réussie. `runtime-sync`
vérifie et applique le jeu, et le retour arrière du déploiement l'annule.

## Mesures (S24, 03/11, même question, `tookMs` du fournisseur)

| Modèle | Durée | Réponse |
|---|---|---|
| gpt-6-luna | 13,6 s | fausse |
| gpt-5.6-luna | 16,6 s | juste, sourcée |
| gpt-6-astra | 17,3 s | juste, sourcée |
| gpt-6.1-sol (défaut) | 20,4 s | juste, sourcée |

Le tour de recherche lui-même dure environ 6 s. Le reste est le démarrage de l'app-server Codex sur le téléphone.

## Limites

- **Activation.** Le S24 porte aujourd'hui l'équivalent appliqué à la main. L'activation remet d'abord les originaux
  sauvegardés, puis applique ce jeu et redémarre la Gateway une fois.
- **Hors périmètre.** L'app-server Codex reste lancé à neuf à chaque recherche, et la bascule « Codex d'abord, Parallel
  en repli » de la capacité `samantha.app.web.*` est à faire dans une suite.
