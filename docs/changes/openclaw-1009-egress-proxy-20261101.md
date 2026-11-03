# OpenClaw 2026.10.9 : la Gateway démarre avec `secrets.egressProxy` (openssl de Termux) — 1er novembre 2026

## Constat

Répétition de la montée 2026.9.6 → 2026.10.9 sur le S24, en préproduction (`upgrade-rehearsal`). Avec
`secrets.egressProxy` configuré comme en prod (`{"enabled": true, "allowedHosts": []}`), la Gateway 10.9 s'arrête au
démarrage du serveur HTTP :
- `secret egress proxy Worker stopped; restart the Gateway to restore protected egress` ;
- puis `Gateway failed to start: Secret egress proxy Worker is unavailable; restart the Gateway.` ;
- puis le triage automatique se lance.

Le Worker ne transmet pas son erreur : il envoie seulement `{kind: "fatal"}`, et ses stdout et stderr sont ignorés.

## Cause exacte

On a appelé `startSecretEgressProxyServer` du candidat, avec le Node 24.22.2 de la préprod, sur un dossier jetable.
L'erreur réelle du Worker est :

```
Error: openssl is required to generate secret egress proxy certificates
    at …/live/openclaw/dist/ca-D3c9PAvv.mjs:78:23
    at withFileLock (…/live/openclaw/dist/file-lock-CkzOvhYo.mjs:150:28)
```

Pour créer l'autorité de certification du proxy, `ensureLocalProxyCa` appelle `resolveSystemBin("openssl")`. Cette
fonction ne cherche que dans `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/run/current-system/sw/bin` et `/snap/bin`.
Elle ignore volontairement le PATH, pour se protéger d'un détournement par PATH. Sur Android :
- `/usr` n'existe pas ;
- `/bin` pointe vers `/system/bin`, qui n'a pas d'openssl ;
- openssl est seulement dans `/data/data/com.termux/files/usr/bin`.

Ce n'est donc **pas** `@openclaw/fs-safe` : le verrou de fichier (`withFileLock`) passe. Aucun chemin n'est refusé,
c'est le binaire qui est introuvable.

Pourquoi la prod 2026.9.6 marche : son `dist/ca-eRx2gloh.mjs` a été corrigé **à la main** le 25/09, hors dépôt. La
sauvegarde `ca-eRx2gloh.mjs.bak-termux-egress-20260925` est encore à côté du fichier. Le correctif ajoute
`{ extraDirs: ["/data/data/com.termux/files/usr/bin"] }` aux deux appels `resolveSystemBin("openssl")` :
`91c6d80e…0a8f` → `9f36e80b…0b2c`. La montée remplace l'arbre OpenClaw, donc ce correctif manuel disparaît.

## Changement

Le jeu épinglé existant `android-fs-compat` reçoit une variante 2026.10.9 de plus, `dist/ca-D3c9PAvv.mjs`
(`63687cc6…5f5f` → `5b1fd3ec…bd2f`). C'est la même ligne que le correctif manuel de la 9.6, aux deux mêmes endroits :
- l'autorité de certification du proxy ;
- les certificats feuilles signés à la demande pour chaque hôte.

Le dossier ajouté est un chemin absolu fixe : il ne vient jamais du PATH ni de `$PREFIX`. Il est cherché après les
dossiers système. Hors Termux, il n'existe pas et rien ne change.

On garde ce jeu parce qu'il est déjà appliqué et contrôlé partout où il faut :
- `gateway-start.sh` l'applique ;
- `runtime-sync.sh` le contrôle et l'applique ;
- le retour arrière de `companion-deploy.sh` le défait ;
- le préflight de la bascule (#507) l'exige sur le candidat.

Un jeu dédié aurait demandé le même câblage en cinq endroits. Sur la 2026.9.6, le jeu ne change rien : le correctif
manuel de la prod n'est ni repris ni défait.

## Fixtures

Dans `openclaw-plugin-mobile-ui/fixtures/openclaw-2026.10.9-compat/` :
- `ca-D3c9PAvv.mjs.gz` : identique à l'octet au fichier du candidat S24, dans `live` comme dans `oc-global` ;
- `resolve-system-bin-COKBgJV4.mjs.gz` : non modifié, il est exécuté par le test.

Les deux viennent de l'archive npm `openclaw@2026.10.9` (sha256 `43c61a00…04ab`).

## Tests (CI : `test-openclaw-compat-variants.py`, `test-openclaw-compat-imports.py`, déjà inscrits)

- Application, contrôle, idempotence et retour exact pour toute la variante 2026.10.9, y compris le module CA. Ces
  tests existaient et couvrent maintenant le nouveau fichier.
- `test_secret_egress_ca_finds_termux_openssl` exécute le vrai module CA publié, avant puis après le correctif, avec
  le vrai `resolveSystemBin`. Les dossiers système sont vus comme sur Android (sans openssl). L'openssl de la machine
  de CI est monté au chemin Termux.
  - Original : l'erreur exacte du S24, sans aucun appel à openssl.
  - Corrigé : la recherche passe par les dossiers système puis par le dossier Termux seul. Le module crée une vraie
    autorité (`CN=OpenClaw Secret Egress Proxy`, clé en 600) puis un certificat feuille valide pour l'hôte.
- `test_android_set_refuses_an_unknown_ca_module_before_any_write` : si l'empreinte du module CA diffère, `apply`,
  `rollback` et `check` refusent (`unsupported_module_hash:dist/ca-D3c9PAvv.mjs`), et aucun fichier du jeu n'est écrit.

## Preuve en préproduction (S24, 01/11, `upgrade-rehearsal`, port 19789, état isolé, canaux et WhatsApp coupés)

Le jeu a été appliqué au candidat par le propriétaire réel (`whatsapp-network-recovery.py --patch-set
android-fs-compat --apply`) :
- résultat `applied`, `changed: 1` ; les 13 autres fichiers étaient déjà corrigés ;
- le contrôle suivant donne `verified` ;
- empreinte sur le S24 : `5b1fd3ec…`, la même que dans le conteneur.

Gateway 10.9 démarrée avec `secrets.egressProxy` `{"enabled": true, "allowedHosts": []}`, comme en prod :
- serveur HTTP à l'écoute en 51,5 s, `/health` à 200 en 65 s ;
- `health --json` correct : 13 plugins, le plugin Samantha chargé, aucune erreur ;
- `status --json` donne `secretEgressProxy: {state: "ready", failedCertificates: 0}` ;
- aucun triage automatique.

Trafic par le proxy : une entrée factice du store de la préprod, `EGP_PROBE`, a été liée à `example.com`. Sa valeur
est un texte de test, pas un secret. Un tour d'agent (201 s) a lancé `curl` par l'outil exec de la Gateway, avec la
sentinelle dans un en-tête. Sortie de la commande :

```
example.com 200
www.iana.org curl: (56) CONNECT tunnel failed, response 403
proxy_env=set ca_env=set
```

Ce que montre cette sortie :
- `HTTPS_PROXY` et `CURL_CA_BUNDLE` viennent de l'autorisation du proxy.
- L'hôte autorisé répond 200 à travers le certificat feuille. Ce certificat est généré par openssl via le second
  appel corrigé.
- L'hôte non autorisé est refusé par le proxy (`allowedHosts: []`, comme en prod).
- Le journal de la Gateway porte deux événements `[secrets/egress-proxy] secret egress request`.

Ensuite :
- la Gateway a été arrêtée ;
- l'entrée factice a été supprimée ;
- la configuration de la préprod a été rendue à l'identique.

La production n'est pas touchée.

## Retour arrière

Revert. Sur un candidat 2026.10.9, le retour arrière du déploiement restaure le module d'origine, avec le reste du jeu.
