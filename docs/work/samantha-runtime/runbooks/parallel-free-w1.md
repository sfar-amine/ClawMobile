# W1 — qualification et retour arrière du fournisseur Parallel Free

État : source de transport proposée ; aucune installation ni activation par Codex. Référence : fichier 53 des playbooks. Claude réalise les opérations runtime avec les procédures existantes après revue. Ce guide n’autorise ni changement global de modèle ni installation pendant un run actif.

## Préparer sans toucher aux consommateurs

1. Relire les contrats actifs et l’état des autres travaux. Capturer pin/release, version exacte OpenClaw et Node, état des plugins et santé Gateway/Companion ; conserver les secrets sur le S24.
2. Vérifier le package npm `@openclaw/parallel-plugin@2026.9.6` et son intégrité depuis le `pin.json` versionné. Utiliser la procédure officielle `openclaw plugins install` dans l’isolation prévue ; ne pas installer `latest`, ne pas ajouter de clé ni modifier tools.web.search.provider globalement. La procédure officielle peut appliquer automatiquement un plugin au Gateway courant : vérifier l’isolation réelle et l’absence d’effet sur la production avant toute installation. Si cette isolation n’est pas garantie, attendre la fenêtre d’intégration canonique.
3. Relever le vrai dossier du plugin installé, jamais le présumer. Vérifier la résolution SDK vers le host 2026.9.6 et le Node compatible (`>=24.16.0 <25 || >=26.1.0`). La présence des exports ne prouve pas leurs signatures. Pour un plugin hors node_modules, l’adaptateur réutilise installedPackageRoot du propriétaire existant à partir du binaire OpenClaw canonique (`CLAWMOBILE_OPENCLAW_BIN` si configuré, sinon PATH). Un hook Node dans ce seul processus résout les onze imports SDK des fichiers officiels hachés ; aucun lien global ni alias pour les autres modules. Le dist du plugin mobile de la release doit avoir été construit par le déploiement normal, car il fournit ce propriétaire déjà utilisé par le Companion.

## Vérifier puis appliquer le seul patch connu

Depuis la release candidate, fournir le dossier observé, sans secret :

```sh
python3 installer/termux-lite/openclaw-compat/parallel-free/patch-provider.py --plugin-dir <dossier-observe>
python3 installer/termux-lite/openclaw-compat/parallel-free/patch-provider.py --plugin-dir <dossier-observe> --apply
```

Le premier appel est une lecture. Le second refuse toute version/dérive, fait un dry-run, applique un seul fichier et revalide tous les hashes. Il est idempotent. Le patch reste dans le propriétaire officiel MCP ; aucun proxy, client HTTP ou magasin parallèle n’est ajouté. Aucun appel ne répare un package inconnu automatiquement.

## Recette de transport seulement

L’intégrateur fixe `CLAW_WEB_PARALLEL_PLUGIN_DIR` dans l’environnement interne contrôlé du processus enfant, avec une allowlist d’environnement. L’adaptateur reçoit uniquement un stdin public minimisé. L’absence de sélecteur ou une intégrité incorrecte donne provider_unavailable/provider_integrity et zéro recherche. La lecture de configuration passe par loadConfig du SDK existant ; seuls les gardes d’activation Web/plugin et allow/deny sont considérés, jamais les clés ni la mémoire utilisateur. Aucun champ de cette configuration n’est transmis à la recherche hormis la politique scoped fixe.

Qualifier une question publique via l’adaptateur : provider effectif parallel-free, auth anonyme, aucune Authorization/Cookie, session_id UUID opaque stable, trois phases transport liées à leurs ids, causes distinctes, cache TTL=0, délais et annulation. L’appel natif peut utiliser le proxy/CA du runtime ; ne pas désactiver TLS. Vérifier les compteurs réellement instrumentés sans exposer les corps ni paramètres privés. Le compteur transport du reçu W1 reste inconnu tant que cette instrumentation n’existe pas.

Le fetch reste désactivé. Une URL validée pour affichage ne constitue pas une autorisation de lecture réseau. La génération Gemini et la voix se qualifient séparément. Ne pas changer de session pour éviter429. L’absence de clé ne garantit ni SLA, ni rétention nulle, ni absence de collecte fournisseur.

## Retour arrière exact

1. Désactiver seulement l’exposition de la nouvelle capability si W2 l’a activée ; annuler ses runs par le propriétaire existant.
2. Depuis le même paquet intact, exécuter :

```sh
python3 installer/termux-lite/openclaw-compat/parallel-free/patch-provider.py --plugin-dir <dossier-observe> --restore
```

3. Le patcher refuse toute dérive. Ne pas réinstaller un ancien openclaw.json, supprimer un dossier partagé ni écraser une modification concurrente. Retirer le plugin seulement s’il a été installé par ce lot et n’est pas partagé.
4. Rétablir pin/release par la procédure canonique de Claude et vérifier santé et consommateurs. Conserver le reçu des versions et de la restauration ; aucune preuve d’activation ne se déduit d’un commit.
